const { connect } = require('puppeteer-core');
const { writeFileSync } = require('fs');
const { convert } = require("./convertToCSV.js");
const { exit } = require('process');

const DEBUGGING_PORT = 9222;
const DATA_URL = "https://provider.nha.gov.in";

const DROPDOWN = ["claims paid", "claims sent to bank"];
const ROWS_PER_PAGE_TO_SET = "50";
const WAIT_TIME_MS = 1000;
const NAV_NEXT_WAIT_TIME_MS = 500;
const START_FROM_PAGE = 1;
const START_FROM_INDEX_ON_PAGE = 0;
const MAX_PATIENT_RETRIES = 3;
const WAIT_FOR_DATA_TIME = 10000;
var TOTAL_NUM = 0;

function cleanClaimData(data) {
    if (!data) return data;
    try {
        if (data.encounter && data.encounter.documents) {
            for (const doc of data.encounter.documents) {
                delete doc.docbase64;
            }
        }
        if (data.treatments && Array.isArray(data.treatments)) {
            for (const treatment of data.treatments) {
                delete treatment.attachments;
            }
        }
    } catch (e) {
        console.error("Error while cleaning data:", e);
    }
    return data;
}

const locks = {
    claim: false,
    logs: false,
    payment: false,
    list: false
}

const flags = {
    claim: false,
    logs: false,
    payment: false,
    list: false
}

async function main() {
    let browser;
    let page;
    let INTERCEPTED_DATA = [];
    let FAILED_PATIENTS = [];
    let patientDataCollector = {};

    try {
        console.log("Connecting to existing browser session...");

        const browserURL = `http://127.0.0.1:${DEBUGGING_PORT}`;
        browser = await connect({
            browserURL: browserURL,
            defaultViewport: null,
        });

        const pages = await browser.pages();
        page = pages.find(p => p.url().startsWith(DATA_URL));

        if (!page) {
            page = pages.find(p => !p.url().startsWith('chrome-extension://'));
        }
        if (!page) {
            throw new Error("Could not find an active page. Make sure you are on the website.");
        }

        const session = await page.target().createCDPSession();
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await session.send('Page.enable');
        await session.send('Page.setWebLifecycleState', { state: 'active' });
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
            Object.defineProperty(document, 'hidden', { value: false, writable: true });
        });

        console.log(`Successfully connected to page: ${page.url()}`);

        if (page.url().includes("login")) {
            throw new Error("Connected to browser, but you are on the login page.");
        }

        console.log("\n--- Starting Scrape ---");

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
        });

        console.log("Setting up network response listener...");

        page.on('response', async (response) => {
            if (response.url().includes("https://apisprod.nha.gov.in/pmjay/provider/provider/claim/info") && locks.claim) {
                try {
                    let data = await response.json();
                    console.log(`Intercepted: claim/info`);
                    data = cleanClaimData(data);
                    patientDataCollector.claim = data;
                    flags.claim = true;
                } catch (e) {
                    console.warn(`\nCould not parse 'claim/info' response as JSON. ${e.message}\n`);
                }
            }
            if (response.url().includes("https://apisprod.nha.gov.in/pmjay/provider/provider/activity/log") && locks.logs) {
                try {
                    let data = await response.json();
                    console.log(`Intercepted: activity/log`);
                    patientDataCollector.log = data;
                    flags.logs = true;
                } catch (e) {
                    console.warn(`\nCould not parse 'activity/log' response as JSON. ${e.message}\n`);
                }
            }
            if (response.url().includes("https://apisprod.nha.gov.in/pmjay/provider/provider/fetch/paymentDtls") && locks.payment) {
                try {
                    let data = await response.json();
                    console.log(`Intercepted: fetch/paymentDtls`);
                    patientDataCollector.payment = data;
                    flags.payment = true;
                } catch (e) {
                    console.warn(`\nCould not parse 'fetch/paymentDtls' response as JSON. ${e.message}\n`);
                }
            }
            if (response.url().includes("https://apisprod.nha.gov.in/pmjay/provider/nproviderdashboard/V3/beneficiary/list") && locks.list) {
                try {
                    console.log(`Intercepted: lists`);
                    flags.list = true;
                } catch (e) {
                    console.warn(`\nCould not parse 'fetch/paymentDtls' response as JSON. ${e.message}\n`);
                }
            }
        });

        try {
            console.log("--- Starting Scrape (Node.js controlled) ---");
            const waitForFlags = async (timeout = 10000) => {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    if (flags.claim && flags.logs && flags.payment) {
                        return true;
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                return false;
            };
            const setRowsPerPage = async (numRows) => {
                const success = await page.evaluate(async (numRows, num) => {
                    const rowsLabel = window.getElementByTextContains('p', 'Rows per page');
                    if (!rowsLabel) return false;
                    const select = rowsLabel.querySelector('select');
                    if (!select) return false;
                    if (select.value === numRows) return true;
                    select.value = numRows.toString();
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    select.dispatchEvent(new Event('input', { bubbles: true }));
                    let m = 100;
                    while (m >= 0) {
                        const list = document.getElementsByClassName("col-lg-4 col-md-6 col-sm-12");
                        if (list.length == 50 || list.length == num % numRows) break;
                        m--;
                        await window.sleep(100);
                    }
                    if (m < 0) return false;
                    return true;
                }, numRows, TOTAL_NUM);
                if (!success) console.error("Failed to set rows per page.");
                return success;
            };

            const navigateToPage = async (targetPage) => {
                return await page.evaluate(async (targetPage, waitMs, navWaitMs) => {
                    let currentPageNum = 1;
                    const currentPageElement = document.querySelector('ul[class*="HqZ6PVq"] li a[aria-current="page"]');
                    if (currentPageElement) {
                        try { currentPageNum = parseInt(currentPageElement.textContent.trim()) || 1; } catch { currentPageNum = 1; }
                    }
                    if (targetPage === currentPageNum) return true;
                    if (targetPage < currentPageNum) {
                        var homeButton = window.getElementByNormalizedText('p', 'Home');
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
                        await window.sleep(navWaitMs)
                    }
                    return true;
                }, targetPage, WAIT_TIME_MS, NAV_NEXT_WAIT_TIME_MS);
            };

            const clickHomeButton = async () => {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle0' }),
                    page.evaluate(() => {
                        const homeButton = window.getElementByNormalizedText('p', 'Home');
                        if (homeButton) {
                            homeButton.closest('div').click();
                        } else {
                            console.error("CRITICAL: 'Home' not found in browser.");
                        }
                    }),
                    page.waitForSelector("select")
                ]);
            };

            const clickRefreshButton = async () => {
                try {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle0' }),
                        page.evaluate(() => {
                            const homeButton = document.getElementById("Path_132011");
                            if (homeButton) {
                                homeButton.parentElement.parentElement.click();
                            } else {
                                console.error("CRITICAL: 'Home' not found in browser.");
                            }
                        }),
                        page.waitForSelector(".col-lg-4.col-md-6.col-sm-12")
                    ]);
                } catch (error) {
                    console.log("error occured while clicking refress button ")
                }
            };

            const reconnect = async () => {
                console.log("reconnecting to the page...");
                const new_pages = await browser.pages();
                page = new_pages.find(p => p.url().startsWith(DATA_URL));
                if (!page || page.isClosed()) {
                    const DATA_URL_CASE = "https://provider.nha.gov.in/caseview";
                    page = new_pages.find(p => p.url().startsWith(DATA_URL_CASE));
                    await clickHomeButton();
                }
                await clickRefreshButton();
                console.log("reconnected");
            }

            for (const DROPDOWN_TEXT_TO_SELECT of DROPDOWN) {
                console.log("Running initial setup (Dropdown)");
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
                let currentPage = START_FROM_PAGE;
                let rowsPerPageNum = parseInt(ROWS_PER_PAGE_TO_SET);
                const dropdowns = await page.$$(".css-bvz1u6-singleValue")
                const dropdown = await dropdowns[1].evaluate(el => el.textContent.trim());
                TOTAL_NUM = parseInt(dropdown.split("(")[1].split(")")[0]);

                while (true) {

                    console.log(`\n==================\nStarting Page ${currentPage}\n==================`);
                    if (!page || page.isClosed()) await reconnect();
                    if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) break;
                    if (!await navigateToPage(currentPage)) break;
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

                    for (let i = startIndex; i < patientCards.length; i++) {
                        if (!page || page.isClosed()) await reconnect();
                        const currentPatientGlobalIndex = (currentPage - 1) * rowsPerPageNum + i;
                        const patientIdentifier = `Patient ${currentPatientGlobalIndex + 1}`;

                        console.log(`\n--- Processing ${patientIdentifier} ---`);

                        let success = false;
                        let retries = 0;

                        patientDataCollector = {};
                        patientDataCollector.type = DROPDOWN_TEXT_TO_SELECT;

                        while (retries < MAX_PATIENT_RETRIES && !success) {
                            try {
                                if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) break;
                                if (!await navigateToPage(currentPage)) break;
                                if (!page || page.isClosed()) await reconnect();
                                const cards = await page.$$(".col-lg-4.col-md-6.col-sm-12");
                                const card = cards[i];
                                if (!card) throw new Error(`Card with index ${i} not found!`);
                                const nameLabel = await card.$('label');
                                const nameFromCard = nameLabel ? await nameLabel.evaluate(el => el.textContent.trim()) : patientIdentifier;

                                if (retries > 0) {
                                    console.log(`Retry ${retries}/${MAX_PATIENT_RETRIES} for ${patientIdentifier}...`);
                                    await clickRefreshButton();
                                    patientDataCollector = {};
                                }


                                const clickableElement = await card.waitForSelector("something", { timeout: 5000 });
                                if (!clickableElement) throw new Error(`clickableElement <something> not found.`);

                                flags.logs = false;
                                flags.payment = false;
                                flags.claim = false;
                                locks.logs = true;
                                locks.payment = true;
                                locks.claim = true;

                                await Promise.all([
                                    page.waitForNavigation({ waitUntil: 'networkidle0' }),
                                    clickableElement.click()
                                ]);

                                console.log(`On detail page`);

                                const gotData = await waitForFlags(WAIT_FOR_DATA_TIME);

                                if (!gotData) {
                                    console.warn(`Timed out. Captured: Claim(${flags.claim}), Log(${flags.logs}), Pay(${flags.payment})`);
                                }

                                locks.logs = false;
                                locks.payment = false;
                                locks.claim = false;

                                console.log("Clicking 'Home' to go back...");
                                await clickHomeButton();

                                await new Promise(resolve => setTimeout(resolve, WAIT_TIME_MS));

                                if (i < patientCards.length - 1) {
                                    console.log("Re-setting page state...");
                                    if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) throw new Error("Failed to set rows after Home click.");
                                    if (!await navigateToPage(currentPage)) throw new Error("Failed to re-navigate to page.");
                                }

                                success = true;

                                if (Object.keys(patientDataCollector).length > 0) {
                                    console.log(`Saving ${Object.keys(patientDataCollector).length} intercepted responses for ${patientIdentifier}`);
                                    patientDataCollector.patientInfo = {
                                        name: nameFromCard,
                                        globalIndex: currentPatientGlobalIndex,
                                        page: currentPage,
                                        indexOnPage: i
                                    };
                                    INTERCEPTED_DATA.push(patientDataCollector);
                                } else {
                                    console.warn(`No API calls were intercepted for ${patientIdentifier}.`);
                                }

                                flags.logs = false;
                                flags.payment = false;
                                flags.claim = false;
                                

                            } catch (e) {
                                retries++;
                                console.error(`ERROR (Attempt ${retries}/${MAX_PATIENT_RETRIES}) for ${patientIdentifier}: ${e.message}`);
                                console.log("Attempting recovery...");
                                page = pages.find(p => p.url().startsWith(DATA_URL));
                                if(!page)throw new Error("Page not found");
                                else console.log("Page connected successfully");
                                try {
                                    const isOnListPage = await page.evaluate(() => window.getElementByTextContains('p', 'Rows per page'));
                                    if (!isOnListPage) {
                                        console.log("Not on list page. Clicking 'Refresh' to recover...");
                                        await clickHomeButton();
                                    } else {
                                        console.log("Already on list page.");
                                    }
                                    await new Promise(resolve => setTimeout(resolve, WAIT_TIME_MS));

                                    console.log("Re-setting page state after recovery...");
                                    if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) throw new Error("Failed to set rows during recovery.");
                                    if (!await navigateToPage(currentPage)) throw new Error("Failed to re-navigate during recovery.");

                                } catch (backError) {
                                    console.error(`CRITICAL: Recovery failed. ${backError.message}`);
                                    retries = MAX_PATIENT_RETRIES;
                                }
                            }
                        }
                        
                        if (!success) {
                            console.error(`--- FAILED: ${patientIdentifier} after ${MAX_PATIENT_RETRIES} attempts. Logging and skipping. ---`);
                            if (!page || page.isClosed()) await reconnect();
                            const cards = await page.$$(".col-lg-4.col-md-6.col-sm-12");
                            const card = cards[i];
                            if (card) {
                                const nameLabel = await card?.$('label');
                                const nameFromCard = nameLabel ? await nameLabel.evaluate(el => el.textContent.trim()) : patientIdentifier;

                                FAILED_PATIENTS.push({
                                    patientIdentifier: patientIdentifier,
                                    globalIndex: currentPatientGlobalIndex,
                                    page: currentPage,
                                    indexOnPage: i,
                                    name: nameFromCard,
                                });
                            }
                        }
                    }

                    const nextDisabled = await page.evaluate(() => {
                        const nextButtonCheck = document.querySelector('li.next a[rel="next"]');
                        return (!nextButtonCheck || nextButtonCheck.getAttribute('aria-disabled') === 'true');
                    });

                    if (nextDisabled) {
                        console.log("Last page reached or 'Next' disabled.");
                        break;
                    }
                    currentPage++;
                }
            }

        } catch (e) {
            console.error(`Error during script execution: ${e.message}`);
        }

        console.log("\n\n=======================================================");
        console.log("--- AUTOMATION COMPLETE ---");
        console.log(`Successfully intercepted and grouped ${INTERCEPTED_DATA.length} patient data objects.`);

        if (INTERCEPTED_DATA.length > 0) {
            const filePath = 'intercepted_api_data.json';
            writeFileSync(filePath, JSON.stringify(INTERCEPTED_DATA, null, 2));
            console.log(`Data saved to ${filePath}`);
            convert();
        } else {
            console.warn("Script finished, but no data was intercepted.");
        }

        if (FAILED_PATIENTS.length > 0) {
            const failedFilePath = 'failed_patients.json';
            console.warn(`--- ${FAILED_PATIENTS.length} PATIENTS FAILED ---`);
            writeFileSync(failedFilePath, JSON.stringify(FAILED_PATIENTS, null, 2));
            console.warn(`Details of failed patients saved to ${failedFilePath}`);
        } else {
            const failedFilePath = 'failed_patients.json';
            writeFileSync(failedFilePath, JSON.stringify({}));
        }

        console.log("--- Scrape Complete ---");
        await browser.disconnect();
        console.log("Script finished. You can now close the Chrome window.");

    } catch (e) {
        console.error("\n--- SCRIPT FAILED ---");
        console.error(e.message);
        if (browser) {
            await browser.disconnect();
        }
    } finally {
        process.stdin.setEncoding('utf8');

        console.log('Enter something to exit:');

        process.stdin.on('data', (data) => {
            console.log("Exiting");
            exit();
        });
    }
}

main();