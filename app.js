if (process.env.NODE_ENV !== "production") {
    require("dotenv").config(); //Load the .env file
}
const path = require('path');
const express = require("express");
const AdmZip = require("adm-zip");
const fs = require("fs");
const fileUpload = require("express-fileupload");

const consolidateExcelFile = require("./excelConsolidation")
const app = express();
const port = process.env.PORT || 3000;
const uploadDestination = process.env.DATAFOLDER_URL || "subcontratistas";

if (!fs.existsSync(path.join(__dirname, uploadDestination))) {
    fs.mkdirSync(path.join(__dirname, uploadDestination), { recursive: true });
}

app.use(fileUpload());

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));

app.post("/uploadfiles", (req, res) => {
    //Guard clause to check if the file exists
    if (!req.files || !req.files.zipFile) {
        return res.status(400).send("No file uploaded");
    }

    const zipFile = req.files.zipFile;

    // Use a unique filename to prevent overwriting
    const uniqueFilename = `${Date.now()}_${zipFile.name}`;
    const uploadedFilePath = `${uploadDestination}${uniqueFilename}`;


    // Move the uploaded file to the specified path
    zipFile.mv(uploadedFilePath, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send("File upload failed");
        }

        try {
            // Create a new AdmZip instance to manipulate the file
            const zip = new AdmZip(uploadedFilePath);

            // Extract the contents of the zip file
            zip.extractAllTo(uploadDestination, /* overwrite */ true);

            // Delete the uploaded zip file
            fs.unlinkSync(uploadedFilePath);

            //Path of extracted folder 
            const pathExtractedFolder = fs.readdirSync(path.join(__dirname, uploadDestination));
            consolidateExcelFile(pathExtractedFolder);

            res.sendFile(__dirname + "/ReporteConsolidado.xlsx")
        } catch (err) {
            console.error(err);
            //Remove all files from the folder 
            fs.rm(path.join(__dirname, uploadDestination), { recursive: true }, () => res.status(500).send("File processing failed"))

        }
    });



});

app.listen(port, () => console.log(`Example app listening on port ${port}!`));
