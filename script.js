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

async function main() {
    let browser;
    let page;
    let INTERCEPTED_DATA = [];
    let FAILED_PATIENTS = [];

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

        const apiRequests = [
            { url: "https://apisprod.nha.gov.in/pmjay/provider/provider/claim/info", key: "claim", cleaner: cleanClaimData },
            { url: "https://apisprod.nha.gov.in/pmjay/provider/provider/activity/log", key: "log", cleaner: (data) => data },
            { url: "https://apisprod.nha.gov.in/pmjay/provider/provider/fetch/paymentDtls", key: "payment", cleaner: (data) => data },
        ];

        try {
            console.log("--- Starting Scrape (Node.js controlled) ---");

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
                let currentPage = await page.evaluate(async () => {
                    const list = document.getElementsByTagName("li");
                    for (let i = 1; i < list.length - 1; i++)if (list[i]?.firstElementChild?.ariaCurrent != null) return parseInt(list[i]?.firstElementChild?.innerText);
                    return 1;
                });
                if (targetPage == currentPage) return true;
                if (targetPage < currentPage) await clickRefreshButton();
                currentPage = 1;
                while(currentPage<targetPage) {
                    const lists = await page.$$('li');
                    const targetLi = lists[lists.length - 1];
                    if (!targetLi) {
                        console.error(`Error: next element not found at index ${targetPage}.`);
                        return false;
                    }
                    const elemToClick = await targetLi.evaluateHandle(li => li.firstElementChild);

                    if (!elemToClick) {
                        console.error(`Error: No first child element found inside <li> at index ${targetPage}.`);
                        return false;
                    }
                    try {
                        const res = page.waitForResponse(response => {
                            const urlMatch = response.url().includes("https://apisprod.nha.gov.in/pmjay/provider/nproviderdashboard/V3/beneficiary/list");
                            const statusOk = response.status() === 200 || response.status() === 202;
                            const isDataRequest = response.request().method() !== 'OPTIONS';
                            return urlMatch && statusOk && isDataRequest;
                        }, { timeout: WAIT_FOR_DATA_TIME })
                        elemToClick.click();
                        await Promise.all([res,page.evaluate(()=>{window.sleep(100)})]);
                        currentPage++;
                        console.log(`Successfully navigated ${currentPage}`);
                    } catch (e) {
                        console.error(`Click or navigation failed: ${e.message}`);
                        return false;
                    }
                }
                console.log(`Successfully navigated using the element at index ${targetPage}.`);
                return true;
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
                    console.log("Refreshing the page");
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
                        if (patientIdentifier > TOTAL_NUM) break;
                        console.log(`\n--- Processing ${patientIdentifier} ---`);

                        let success = false;
                        let retries = 0;

                        let patientDataCollector = {};
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
                                    patientDataCollector.type = DROPDOWN_TEXT_TO_SELECT;
                                }

                                const clickableElement = await card.waitForSelector("something", { timeout: 5000 });
                                if (!clickableElement) throw new Error(`clickableElement <Something> not found.`);

                                const responsePromises = apiRequests.map(({ url, key, cleaner }) =>
                                    page.waitForResponse(response => {
                                        const urlMatch = response.url().includes(url);
                                        const statusOk = response.status() === 200 || response.status() === 202;
                                        const isDataRequest = response.request().method() !== 'OPTIONS';
                                        return urlMatch && statusOk && isDataRequest;
                                    }, { timeout: WAIT_FOR_DATA_TIME })
                                        .then(async (response) => {
                                            let data = await response.json();
                                            console.log(`Intercepted: ${key}`);
                                            return { key, data: cleaner(data) };
                                        })
                                        .catch(e => {
                                            console.warn(`Timeout/Error waiting for ${key}: ${e.message}`);
                                            return { key, data: null };
                                        })
                                );

                                const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0' });
                                const clickPromise = clickableElement.click();
                                console.log(`On detail page. Triggering click and waiting for API data...`);

                                const results = await Promise.all([
                                    ...responsePromises,
                                    navigationPromise,
                                    clickPromise
                                ]);
                                const interceptedResponses = results.slice(0, apiRequests.length);
                                let dataCapturedCount = 0;

                                for (const { key, data } of interceptedResponses) {
                                    if (data) {
                                        patientDataCollector[key] = data;
                                        dataCapturedCount++;
                                    }
                                }

                                if (dataCapturedCount === 0) {
                                    console.warn(`Timed out. No API data was captured.`);
                                    success = false;
                                } else {
                                    console.log(`Captured ${dataCapturedCount}/${apiRequests.length} data points.`);
                                    success = true;
                                }

                                console.log("Clicking 'Home' to go back...");
                                await clickHomeButton();

                                await new Promise(resolve => setTimeout(resolve, WAIT_TIME_MS));

                                if (i < patientCards.length - 1) {
                                    console.log("Re-setting page state...");
                                    if (!await setRowsPerPage(ROWS_PER_PAGE_TO_SET)) throw new Error("Failed to set rows after Home click.");
                                    if (!await navigateToPage(currentPage)) throw new Error("Failed to re-navigate to page.");
                                }

                                success = true;

                                if (Object.keys(patientDataCollector).length > 1) {
                                    console.log(`Saving ${Object.keys(patientDataCollector).length - 1} intercepted responses for ${patientIdentifier}`);
                                    patientDataCollector.patientInfo = {
                                        name: nameFromCard,
                                        globalIndex: currentPatientGlobalIndex,
                                        page: currentPage,
                                        indexOnPage: i
                                    };
                                    INTERCEPTED_DATA.push(patientDataCollector);
                                } else {
                                    console.warn(`No API calls were successfully intercepted for ${patientIdentifier}.`);
                                }

                            } catch (e) {
                                retries++;
                                console.error(`ERROR (Attempt ${retries}/${MAX_PATIENT_RETRIES}) for ${patientIdentifier}: ${e.message}`);
                                console.log("Attempting recovery...");
                                const new_pages = await browser.pages();
                                page = new_pages.find(p => p.url().startsWith(DATA_URL));
                                if (!page) throw new Error("Page not found");
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