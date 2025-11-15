import { connect } from 'puppeteer-core';
import { writeFileSync } from 'fs';
import {main as convertToMultipleCSVs} from "./convertToCSV.js"

// --- Configuration ---
const DEBUGGING_PORT = 9222;
const DATA_URL = "https://provider.nha.gov.in";

// --- User Settings (from your script) ---
const DROPDOWN_TEXT_TO_SELECT = "Claims Paid";//change this to what you want to search
const ROWS_PER_PAGE_TO_SET = "50";
const WAIT_TIME_MS = 1000;
const NAV_NEXT_WAIT_TIME_MS = 500;
const START_FROM_PAGE = 1;
const START_FROM_INDEX_ON_PAGE = 0;
const MAX_PATIENT_RETRIES = 3;


function cleanClaimData(data) {
    if (!data) return data;
    try {
        // Your existing logic for encounter.documents
        if (data.encounter && data.encounter.documents) {
            for (const doc of data.encounter.documents) {
                delete doc.docbase64;
            }
        }
        // Your new logic for treatments
        if (data.treatments && Array.isArray(data.treatments)) {
            for (const treatment of data.treatments) {
                // Using 'delete' is safer than setting to null
                delete treatment.attachments;
            }
        }
    } catch (e) {
        console.error("Error while cleaning data:", e);
    }
    return data; 
}


// --- MAIN SCRIPT ---
(async () => {
    let browser;
    let page; // Define page in the outer scope
    let INTERCEPTED_DATA = []; // This will now store the *grouped* patient objects
    let FAILED_PATIENTS = []; // Array to track patients who failed all retries
    
    // --- NEW: Data collector for a single patient ---
    let patientDataCollector = {};

    try {
        console.log("Connecting to existing browser session...");

        // --- A. Connect to the browser ---
        const browserURL = `http://127.0.0.1:${DEBUGGING_PORT}`;
        browser = await connect({
            browserURL: browserURL,
            defaultViewport: null, // Use the browser's existing viewport
        });

        const pages = await browser.pages();
        page = pages.find(p => p.url().startsWith(DATA_URL));

        if (!page) {
            page = pages.find(p => !p.url().startsWith('chrome-extension://'));
        }
        if (!page) {
            throw new Error("Could not find an active page. Make sure you are on the website.");
        }

        console.log(`Successfully connected to page: ${page.url()}`);

        if (page.url().includes("login")) {
            throw new Error("Connected to browser, but you are on the login page.");
        }

        console.log("\n--- Starting Scrape ---");

        // --- B. Inject All Browser-Side Functions ---
        // (Minimal logs inside these functions)
        await page.evaluate(() => {
            
            window.sleep = (ms) => {
                return new Promise(resolve => setTimeout(resolve, ms));
            };

            window.getElementByTextContains = (tag, text, context = document) => {
                const lowerText = text.toLowerCase().trim();
                const xpath = `.//${tag}[contains(normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')), '${lowerText}')]`;
                try {
                    return document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                } catch (e) {
                    return null;
                }
            };

            window.getElementByNormalizedText = (tag, text, context = document) => {
                const lowerText = text.toLowerCase();
                const xpath = `.//${tag}[normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')) = '${lowerText}']`;
                try {
                    return document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                } catch (e) {
                    return null;
                }
            };

            // --- FIXED: Reverted to the working XPath version ---
            window.getPatientCardInfo = () => {
                console.log("hello")
                const cards = [];
                // 1. Get all card containers using your new class name
                const cardContainers = document.getElementsByClassName("col-lg-4 col-md-6 col-sm-12");
                console.log("logging: " , cardContainers);

                try {
                    // 3. Loop using .length and access with [i]
                    for (let i = 0; i < cardContainers.length; i++) {
                        const cardContainer = cardContainers[i];
                        
                        // 4. Check if it's a valid patient card
                        if (cardContainer && cardContainer.querySelector('small') && getElementByTextContains('small', 'Registration ID', cardContainer)) {
                            let tempName = `Patient ${i + 1}`;
                            try { tempName = cardContainer.querySelector('label')?.textContent.trim() ?? tempName; } catch (e) { }
                            const clickSelector = cardContainer.getElementsByTagName("something");

                            cards.push({
                                nameFromCard: tempName,
                                clickSelector: clickSelector // Return the *selector string*
                            });
                        }
                    }
                } catch (e) { console.error("Error in getPatientCardInfo:", e); }
                return cards;
            };

        });


        // --- C. Intercepting Network Responses ---
        console.log("Setting up network response listener...");
        
        // Listener 1: Claim Info
        page.on('response', async (response) => {
            if (response.url().includes("claim/info")) {
                try {
                    let data = await response.json();
                    console.log(`Intercepted: claim/info`);
                    // --- CLEAN THE DATA ---
                    data = cleanClaimData(data);
                    // --- END CLEANING ---
                    
                    // Add to the collector
                    patientDataCollector.claim = data;

                } catch (e) {
                    console.warn(`\nCould not parse 'claim/info' response as JSON. ${e.message}\n`);
                }
            }
        });
        
        // Listener 2: Activity Log
        page.on('response', async (response) => {
            if (response.url().includes("activity/log")) {
                try {
                    let data = await response.json();
                    console.log(`Intercepted: activity/log`);
                    // Add to the collector
                    patientDataCollector.log = data;

                } catch (e) {
                    console.warn(`\nCould not parse 'activity/log' response as JSON. ${e.message}\n`);
                }
            }
        });
        
        // Listener 3: Payment Details
        page.on('response', async (response) => {
            if (response.url().includes("fetch/paymentDtls")) {
                try {
                    let data = await response.json();
                    console.log(`Intercepted: fetch/paymentDtls`);
                    // Add to the collector
                    patientDataCollector.payment = data;

                } catch (e) {
                    console.warn(`\nCould not parse 'fetch/paymentDtls' response as JSON. ${e.message}\n`);
                }
            }
        });

        // --- D. Node.js-Controlled Scraping Logic ---
        
        try {
            console.log("--- Starting Scrape (Node.js controlled) ---");
            
            // --- Helper Functions (Run from Node.js, minimal logs) ---
            
            const setRowsPerPage = async (numRows) => {
                // ... (existing setRowsPerPage function) ...
                const success = await page.evaluate(async (numRows, waitMs) => {
                    const rowsLabel = getElementByTextContains('p', 'Rows per page');
                    if (!rowsLabel) return false;
                    const select = rowsLabel.querySelector('select');
                    if (!select) return false;
                    if (select.value === numRows) return true;
                    select.value = numRows.toString();
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    select.dispatchEvent(new Event('input', { bubbles: true }));
                    await window.sleep(waitMs);
                    return true;
                }, numRows, WAIT_TIME_MS);
                if (!success) console.error("Failed to set rows per page.");
                return success;
            };

            const navigateToPage = async (targetPage) => {
                // ... (existing navigateToPage function) ...
                return await page.evaluate(async (targetPage, waitMs, navWaitMs) => {
                    let currentPageNum = 1;
                    const currentPageElement = document.querySelector('ul[class*="HqZ6PVq"] li a[aria-current="page"]');
                    if (currentPageElement) {
                        try { currentPageNum = parseInt(currentPageElement.textContent.trim()) || 1; } catch { currentPageNum = 1; }
                    }
                    if (targetPage === currentPageNum) return true;
                    if (targetPage < currentPageNum) {
                        var homeButton = getElementByNormalizedText('p', 'Home');
                        if (homeButton) {
                            homeButton.closest('div').click(); 
                            await window.sleep(waitMs);
                            return (targetPage === 1);
                        } else { return false; }
                    }
                    for (let i = currentPageNum; i < targetPage; i++) {
                        const nextButton = document.querySelector('li.next a[rel="next"]');
                        if (!nextButton || nextButton.getAttribute('aria-disabled') === 'true') return false;
                        nextButton.click(); 
                        await window.sleep(navWaitMs);
                    }
                    await window.sleep(200);
                    return true;
                }, targetPage, WAIT_TIME_MS, NAV_NEXT_WAIT_TIME_MS);
            };

            const clickHomeButton = async () => {
                // ... (existing clickHomeButton function) ...
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle0' }),
                    page.evaluate(() => {
                        const homeButton = getElementByNormalizedText('p', 'Home');
                        if (homeButton) {
                            homeButton.closest('div').click();
                        } else {
                            console.error("CRITICAL: 'Home' not found in browser.");
                        }
                    })
                ]);
            };

            // --- 1. Initial Setup (Run in Browser) ---
            console.log("Running initial setup (Dropdown)...");
            // ... (existing initial setup code) ...
            await page.evaluate(async (TEXT, WAIT) => {
                try {
                    const input = document.querySelector('label[for="patientStatus"] + div input[id*="-input"]');
                    if (!input) { console.error("CRITICAL: Dropdown not found."); return; }
                    input.focus();
                    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                    nativeInputValueSetter.call(input, TEXT);
                    input.dispatchEvent(new Event('input', { bubbles: true })); await window.sleep(300);
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    input.blur(); await window.sleep(WAIT);
                } catch (e) {
                    console.error("CRITICAL: Failed initial setup.", e);
                }
            }, DROPDOWN_TEXT_TO_SELECT, WAIT_TIME_MS);
            
            // --- 2. Main Scraping Loop (Controlled by Node.js) ---
            let currentPage = START_FROM_PAGE;
            let rowsPerPageNum = parseInt(ROWS_PER_PAGE_TO_SET);

            while (true) {
                console.log(`\n==================\nStarting Page ${currentPage}\n==================`);
                
                if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) break;
                if (!await navigateToPage(currentPage)) break;

                // const patientCards = await page.evaluate(() => window.getPatientCardInfo());
                const patientCards = await page.$$(".col-lg-4.col-md-6.col-sm-12");
                
                if (patientCards.length === 0) {
                     console.log("No patient cards found. Checking for 'Next' button...");
                     const nextDisabled = await page.evaluate(() => {
                         const nextButtonCheck = document.querySelector('li.next a[rel="next"]');
                         return (!nextButtonCheck || nextButtonCheck.getAttribute('aria-disabled') === 'true');
                     });
                     if (nextDisabled) console.log("Last page reached.");
                     else console.warn("Not last page, but empty. Stopping.");
                     break;
                }
                
                const startIndex = (currentPage === START_FROM_PAGE) ? START_FROM_INDEX_ON_PAGE : 0;
                console.log(`Found ${patientCards.length} cards. Starting from index ${startIndex}.`);

                // Loop through patients on the page
                for (let i = startIndex; i < patientCards.length; i++) {
                    const currentPatientGlobalIndex = (currentPage - 1) * rowsPerPageNum + i;
                    const patientIdentifier = `Patient ${currentPatientGlobalIndex + 1}`;
                    
                    console.log(`\n--- Processing ${patientIdentifier} ---`);

                    let success = false;
                    let retries = 0;
                    
                    // --- CLEAR THE COLLECTOR FOR THE NEW PATIENT ---
                    patientDataCollector = {};

                    // --- RETRY LOOP FOR EACH PATIENT ---
                    while (retries < MAX_PATIENT_RETRIES && !success) {
                        const cards = await page.$$(".col-lg-4.col-md-6.col-sm-12");
                        const card = cards[i];
                        if (retries > 0) {
                            console.log(`Retry ${retries}/${MAX_PATIENT_RETRIES} for ${patientIdentifier}...`);
                            // Clear collector again on retry
                            patientDataCollector = {};
                        }

                        try {
                            const clickableElement = await card.$("something");
                            if (!clickableElement) throw new Error(`clickableElement not found.`);
                            
                            // --- 2. Navigate to Detail Page ---
                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'networkidle0' }),
                                clickableElement.click()
                            ]);
                            
                            // --- 3. Go Back Home ---
                            console.log(`On detail page. Clicking 'Home' to go back...`);
                            await clickHomeButton();
                            
                            // --- 4. Wait and Reset State ---
                            await new Promise(resolve => setTimeout(resolve, WAIT_TIME_MS));
                            
                            if (i < patientCards.length - 1) { // Don't reset if it's the last patient on page
                                console.log("Re-setting page state...");
                                if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) throw new Error("Failed to set rows after Home click.");
                                if (!await navigateToPage(currentPage)) throw new Error("Failed to re-navigate to page.");
                            }
                            
                            success = true; // Mark as successful
                            
                            // --- 5. SAVE THE COLLECTED DATA (NEW) ---
                            if (Object.keys(patientDataCollector).length > 0) {
                                console.log(`Saving ${Object.keys(patientDataCollector).length} intercepted responses for ${patientIdentifier}`);
                                // Add patient info for context
                                patientDataCollector.patientInfo = {
                                    name: card.nameFromCard,
                                    globalIndex: currentPatientGlobalIndex,
                                    page: currentPage,
                                    indexOnPage: i
                                };
                                INTERCEPTED_DATA.push(patientDataCollector);
                            } else {
                                console.warn(`No API calls were intercepted for ${patientIdentifier}.`);
                            }

                        } catch (e) {
                            retries++;
                            console.error(`ERROR (Attempt ${retries}/${MAX_PATIENT_RETRIES}) for ${patientIdentifier}: ${e.message}`);
                            console.log("Attempting recovery...");
                            
                            try {
                               const isOnListPage = await page.evaluate(() => window.getElementByTextContains('p', 'Rows per page'));
                               if (!isOnListPage) {
                                   console.log("Not on list page. Clicking 'Home' to recover...");
                                   await clickHomeButton();
                               } else {
                                   console.log("Already on list page.");
                               }
                               await new Promise(resolve => setTimeout(resolve, WAIT_TIME_MS));
                               
                               // Always reset state after a failure
                               console.log("Re-setting page state after recovery...");
                               if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) throw new Error("Failed to set rows during recovery.");
                               if (!await navigateToPage(currentPage)) throw new Error("Failed to re-navigate during recovery.");

                            } catch (backError) {
                                console.error(`CRITICAL: Recovery failed. ${backError.message}`);
                                retries = MAX_PATIENT_RETRIES; 
                            }
                        }
                    } // --- END OF RETRY LOOP ---

                    if (!success) {
                        // ... (existing failure logging) ...
                        console.error(`--- FAILED: ${patientIdentifier} after ${MAX_PATIENT_RETRIES} attempts. Logging and skipping. ---`);
                        FAILED_PATIENTS.push({
                            patientIdentifier: patientIdentifier,
                            globalIndex: currentPatientGlobalIndex,
                            page: currentPage,
                            indexOnPage: i,
                            name: card.nameFromCard,
                        });
                    }

                } 

                // ... (existing next page check) ...
                const nextDisabled = await page.evaluate(() => {
                    const nextButtonCheck = document.querySelector('li.next a[rel="next"]');
                    return (!nextButtonCheck || nextButtonCheck.getAttribute('aria-disabled') === 'true');
                });
                
                if (nextDisabled) {
                    console.log("Last page reached or 'Next' disabled.");
                    break; // Exit while loop
                }
                currentPage++;
                
            }
            
        } catch (e) {
            console.error(`Error during script execution: ${e.message}`);
        }

        // --- E. Save the results ---
        console.log("\n\n=======================================================");
        console.log("--- AUTOMATION COMPLETE ---");
        console.log(`Successfully intercepted and grouped ${INTERCEPTED_DATA.length} patient data objects.`);
        
        if (INTERCEPTED_DATA.length > 0) {
            const filePath = 'intercepted_api_data.json';
            writeFileSync(filePath, JSON.stringify(INTERCEPTED_DATA, null, 2));
            console.log(`Data saved to ${filePath}`);
            convertToMultipleCSVs();
        } else {
            console.warn("Script finished, but no data was intercepted.");
        }

        if (FAILED_PATIENTS.length > 0) {
            const failedFilePath = 'failed_patients.json';
            console.warn(`--- ${FAILED_PATIENTS.length} PATIENTS FAILED ---`);
            writeFileSync(failedFilePath, JSON.stringify(FAILED_PATIENTS, null, 2));
            console.warn(`Details of failed patients saved to ${failedFilePath}`);
        }else{
            const failedFilePath = 'failed_patients.json';
            writeFileSync(failedFilePath, JSON.stringify({}));
        }

        console.log("--- Scrape Complete ---");
        await browser.disconnect();
        console.log("Script finished. You can now close the Chrome window.");

    } catch (e) {
        console.error("\n--- SCRIPT FAILED ---");
        // ... (existing error handling) ...
        console.error(e.message);
        console.log("\nCommon Errors:");
        console.log(`1. Did you start Chrome with '--remote-debugging-port=${DEBUGGING_PORT}'?`);
        console.log("2. Is the Chrome window still open?");
        console.log("3. Did you manually log in to the website in that window?");
        if (browser) {
            await browser.disconnect();
        }
    }
})();