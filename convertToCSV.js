const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

/**
 * Converts the complex nested JSON into a set of related CSV files.
 * This creates a main 'claims.csv' for summary and other files for details.
 *
 * @param {Array<Object>} records - An array of the combined records from all files.
 * @returns {Object<string, string>} An object where keys are filenames (e.g., "claims.csv")
 * and values are the CSV data as strings.
 */
function convertToMultipleCSVs(records) {
    // Helper to escape CSV fields
    const escapeCSV = (val) => {
        if (val === null || val === undefined) return "";
        let str = String(val);
        if (str.includes(",") || str.includes("\n") || str.includes('"')) {
            str = str.replace(/"/g, '""'); // Double up existing quotes
            return `"${str}"`; // Wrap in quotes
        }
        return str;
    };

    // Define headers for our 7 CSV files
    const headers = {
        patients: [
            "Registration Id", "Patient Name", "Patient Phone", "Patient Address", "Diagnosis", "Treatment", "Date of Admission",
            "Discharge Date", "Length of stay", "Treatment Plan Breakup", "Claimed Amount","Claimed amount after Dedcuctions","Claimed Amount Deduction","Claimed Amount Deduction(%)","Claimed Amount Deduction Breakup" ,"Claimed Amount Breakup","Total Claims(With Incentives)", "Claims Approved", "TDS",
            "Settled to Bank", "Settlement Date", "Claims Approved Breakup", "Case Logs", "Payment TAT", "Deduction Amount",
            "Deduction %", "Num of Queries", "Deduction Breakup"
        ]
    };

    // Initialize arrays to hold all our rows
    const rows = {
        patients: []
    };

    // Process each record in the main JSON array
    for (const record of records) {
        const claim = record?.claim ?? {};
        const encounter = claim?.encounter ?? {};
        const amount = claim?.amount ?? {};
        const caseNumber = claim?.casenumber;

        if (!caseNumber) continue;

        // 1. Build the row for claims.csv
        //Pateint details
        const patient_no = encounter?.patientnumber
        const patient_phone_no = encounter?.patientcontacts[0]?.contactnumber;
        const patient_address = encounter?.patientaddress[0]?.addressline1 + (encounter?.patientaddress[0]?.addressline2 ? "    " + encounter?.patientaddress[0]?.addressline2 : "");
        const carePlanID = encounter.careplanid;
        const carePlanCode = encounter.careplancode;
        const deduction = amount.totalamount - amount.amountapproved;
        const deduction_percentage = (deduction / amount.totalamount) * 100;
        // 2. Build rows for payments.csv
        let payments = "";
        let tds = 0;
        let transactionDate = null;
        let status = "";
        (record?.payment ?? []).forEach(p => {
            if (p?.paymenttype == "TDS") {
                tds = p?.transactionamount;
                transactionDate = p?.transactiondate;
                status = p?.paymentstatus;
            }
            payments += p?.paymentstatus + "    " + p?.remarks + "    " + p?.paymenttype + "    " + p?.transactionamount + "    " + p?.transactiondate + "    " + p?.paiddate + "    " + p?.paymentuniqueId + '\n';
        });

        let logs = "";
        let numQuery = 0;
        (record?.log ?? []).forEach(l => {
            if (l?.status == "Claim Queried") numQuery++;
            logs += l?.sno + "    " + l?.process + "    " + l?.raiseddate + "    " + l?.updateddate + "    " + l?.type + "    " + l?.status + "    " + l?.remarks + "    " + l?.user + "    " + l?.amount + "\n"
        });

        // 4. Build rows for diagnoses.csv
        let diagnosis = "";
        (claim?.diagnosis ?? []).forEach(d => {
            diagnosis += d?.sno + "    " + d.display+ "\n"
        });

        // 5. Build rows for treatments.csv
        let treatments = "";
        (claim?.treatments ?? []).forEach(t => {
            treatments += t?.sno + "    " + t?.proceduretype + "    " + t?.procedurename + "    " + t?.typedesc + "    " + t?.amount + "    " + t?.packagecode + "    " + t?.packagename + "    " + t?.status + "\n"
        });

        // 6. Build rows for diagnoses.csv
        let amounts = "";
        let deductionBreakUp = "";
        (claim?.amount?.calculatedamount ?? []).forEach(d => {
            if (parseFloat(d?.netamount) != (parseFloat(d?.packagecost) * parseFloat(d?.quantity))) deductionBreakUp += (parseFloat(d?.packagecost) * parseFloat(d?.quantity)) - parseFloat(d?.amount) + "\n"
            amounts += d?.packagecost + "    " + d?.status + "    " + "qnty: " + d?.quantity + "    " + d?.approvedfactor + "    " + d?.amount + "\n"
        });

        // 7. Build rows for diagnoses.csv
        let amountapproved = "";
        (claim?.amount?.calculatedamount ?? []).forEach(d => {
            if (d?.status == "Approved") amountapproved += d?.packagecost + "    " + d?.status + "    " + "qnty: " + d?.quantity + "    " + d?.approvedfactor + "    " + d?.amount + "\n"
        });

        // 7. Base decductions
        let baseDeductions = "";
        (claim?.amount?.calculatedamount ?? []).forEach(d => {
            if ((d?.approvedfactor?.split("%").length > 1) && (parseInt(d?.approvedfactor?.split("%")[0]) < 100)) baseDeductions += d?.packagecost + "    " + d?.status + "    " + "qnty: " + d?.quantity + "    " + d?.approvedfactor + "    " + d?.amount + "\n"
        });

        // 8. Base decductions
        let Deductions = "";
        (claim?.amount?.calculatedamount ?? []).forEach(d => {
            if(d.deductions)for(let deduction of d.deductions)Deductions += deduction.deductedamount + "    " + deduction.deductiondescription + "\n"
        });

        let dischargeDate = claim.dischargedate.split("/");
        const date = dischargeDate[0];
        dischargeDate[0] = dischargeDate[1];
        dischargeDate[1] = date;
        dischargeDate = dischargeDate.join("/")

        let admissiondate = claim.admissiondate.split("/");
        const datee = admissiondate[0];
        admissiondate[0] = admissiondate[1];
        admissiondate[1] = datee;
        admissiondate = admissiondate.join("/")


        const TAT = Math.ceil((new Date(transactionDate) - new Date(dischargeDate)) / 86400000);
        const stay = Math.ceil((new Date(dischargeDate) - new Date(admissiondate)) / 86400000);
        const baseDeduction = amount.packageamount - amount.totalpackageamount;
        const baseDeductionPercentage = (baseDeduction / amount.packageamount) * 100; 

        rows.patients.push([
            patient_no, encounter.patientname, patient_phone_no, patient_address, diagnosis, claim.treatments[0]?.procedurename, claim.admissiondate, claim.dischargedate, stay, treatments,
            amount.packageamount, amount.totalpackageamount, baseDeduction, baseDeductionPercentage, baseDeductions,amounts, amount.totalamount, amount.amountapproved, tds, status, transactionDate,amountapproved, logs, TAT, deduction, deduction_percentage, numQuery, Deductions
        ].map(escapeCSV).join(','));
    }

    // Combine headers and rows for each file
    const csvFiles = {};
    for (const key in headers) {
        csvFiles[`${key}.csv`] = [headers[key].join(','), ...rows[key]].join('\n');
    }

    return csvFiles;
}

// --- Main execution ---
function convert() {
    const filesToProcess = ['intercepted_api_data.json'];
    let allRecords = [];

    // Step 1: Read and parse all JSON files
    for (const fileName of filesToProcess) {
        try {
            const filePath = resolve(fileName); // Assumes files are in the same directory
            const fileContent = readFileSync(filePath, 'utf-8');
            const records = JSON.parse(fileContent);
            if (Array.isArray(records)) {
                allRecords.push(...records);
            } else {
                console.warn(`File ${fileName} does not contain a JSON array. Skipping.`);
            }
        } catch (err) {
            console.error(`Error reading file ${fileName}: ${err.message}`);
        }
    }

    if (allRecords.length === 0) {
        console.error("No records found. Exiting.");
        return;
    }

    console.log(`Successfully processed ${allRecords.length} records from ${filesToProcess.length} files.`);

    // Step 2: Convert the combined data to CSVs
    const csvData = convertToMultipleCSVs(allRecords);

    // Step 3: Write all CSV files to disk
    let filesWritten = 0;
    for (const filename in csvData) {
        try {
            const outputFilePath = resolve(filename); // Save in the same directory
            writeFileSync(outputFilePath, csvData[filename], 'utf-8');
            console.log(`✅ Successfully saved ${filename}`);
            filesWritten++;
        } catch (err) {
            console.error(`❌ Error writing ${filename}: ${err.message}`);
        }
    }

    console.log(`\nDone. Wrote ${filesWritten} CSV files.`);
}

module.exports = {convert};