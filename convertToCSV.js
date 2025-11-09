import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Converts the complex nested JSON into a set of related CSV files.
 * This creates a main 'claims.csv' for summary and other files for details.
 *
 * @param {Array<Object>} records - An array of the combined records from all files.
 * @returns {Object<string, string>} An object where keys are filenames (e.g., "claims.csv")
 * and values are the CSV data as strings.
 */
export function convertToMultipleCSVs(records) {
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
        claims: [
            "CaseNumber", "PatientNumber", "PatientName", "PatientPhoneNumber", "CarePlanID", "CarePlanCode", "AdmissionDate", "DischargeDate", "SurgeryDate", "RegistrationDate",
            "TotalAmount", "AmountApproved", "TDSAmount", "Deducted", "DeductionPercentage",
            "PatientDOB", "PatientGender","Patientaddress", "ProviderName", "PayerName",
            "FinalCPDRecommendation", "FinalACORecommendation"
        ],
        payments: [
            "CaseNumber", "PaymentStatus", "Remarks", "PaymentType", "TransactionAmount",
            "TransactionDate", "PaidDate", "PaymentUniqueID"
        ],
        logs: [
            "CaseNumber", "Sno", "Process", "RaisedDate", "UpdatedDate", "Type",
            "Status", "Remarks", "User", "Amount"
        ],
        diagnoses: [
            "CaseNumber", "Sno", "Type", "Code", "Display", "PackageCode",
            "PackageName", "Amount", "Status"
        ],
        treatments: [
            "CaseNumber", "Sno", "ProcedureType", "ProcedureName", "TypeDesc", "Amount",
            "PackageCode", "PackageName", "Status"
        ],
        documents: [
            "CaseNumber", "Sno", "DocType", "DocName", "DocPath", "ProviderDocName",
            "ProviderDocPath", "Verified"
        ],
        addresses: [
            "CaseNumber", "Address","City", "District", "State", "Pincode", "Contact"
        ]
    };

    // Initialize arrays to hold all our rows
    const rows = {
        claims: [], payments: [], logs: [], diagnoses: [],
        treatments: [], documents: [], addresses: []
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
        const patient_address = encounter?.patientaddress[0]?.addressline1 + (encounter?.patientaddress[0]?.addressline2 ? " " + encounter?.patientaddress[0]?.addressline2 : "");
        const carePlanID = encounter.careplanid;
        const carePlanCode = encounter.careplancode;
        const deduction = amount.totalamount-amount.amountapproved;
        const deduction_percentage = (deduction/amount.totalamount) * 100;
        rows.claims.push([
            caseNumber, patient_no, encounter.patientname, patient_phone_no, carePlanID, carePlanCode, claim.admissiondate, claim.dischargedate, claim.surgerydate, claim.registrationdate,
            amount.totalamount, amount.amountapproved,amount.tdsDeduction, deduction, deduction_percentage,
            encounter.patientdob, encounter.patientgender,patient_address, encounter.providername, encounter.payername,
            claim.finalCPDRecommendation, claim.finalACORecommendation
        ].map(escapeCSV).join(','));

        // 2. Build rows for payments.csv
        (record?.payment ?? []).forEach(p => {
            rows.payments.push([
                caseNumber, p?.paymentstatus, p?.remarks, p?.paymenttype, p?.transactionamount,
                p?.transactiondate, p?.paiddate, p?.paymentuniqueId
            ].map(escapeCSV).join(','));
        });

        // 3. Build rows for logs.csv
        (record?.log ?? []).forEach(l => {
            rows.logs.push([
                caseNumber, l?.sno, l?.process, l?.raiseddate, l?.updateddate, l?.type,
                l?.status, l?.remarks, l?.user, l?.amount
            ].map(escapeCSV).join(','));
        });

        // 4. Build rows for diagnoses.csv
        (claim?.diagnosis ?? []).forEach(d => {
            rows.diagnoses.push([
                caseNumber, d?.sno, d?.type, d?.code, d?.display, d?.packagecode,
                d?.packagename, d?.amount, d?.status
            ].map(escapeCSV).join(','));
        });

        // 5. Build rows for treatments.csv
        (claim?.treatments ?? []).forEach(t => {
            rows.treatments.push([
                caseNumber, t?.sno, t?.proceduretype, t?.procedurename, t?.typedesc, t?.amount,
                t?.packagecode, t?.packagename, t?.status
            ].map(escapeCSV).join(','));
        });

        // 6. Build rows for documents.csv
        (record?.document ?? []).forEach(d => {
            rows.documents.push([
                caseNumber, d?.sno, d?.doctype, d?.docname, d?.docpath, d?.providerdocname,
                d?.providerdocpath, d?.verified
            ].map(escapeCSV).join(','));
        });

        // 7. Build rows for addresses.csv
        (encounter?.patientaddress ?? []).forEach(a => {
            rows.addresses.push([
                caseNumber, patient_address, a?.city, a?.district,a?.state, a?.pincode, patient_phone_no
            ].map(escapeCSV).join(','));
        });
    }

    // Combine headers and rows for each file
    const csvFiles = {};
    for (const key in headers) {
        csvFiles[`${key}.csv`] = [headers[key].join(','), ...rows[key]].join('\n');
    }

    return csvFiles;
}

// --- Main execution ---
export function main() {
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

// Run the script
main();