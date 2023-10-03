if (process.env.NODE_ENV !== "production") {
    require("dotenv").config(); //Load the .env file
}
//Library Imports
const axios = require("axios");
const path = require('path');
const express = require("express");
const AdmZip = require("adm-zip");
const fs = require("fs");
const fileUpload = require("express-fileupload");
const ejs = require('ejs');
const app = express();

//Modules
const { getCurrentProgress, consolidateExcelFile } = require("./excelConsolidation")

//Environmental Variables 
const port = process.env.PORT || 3000;
const uploadDestination = process.env.DATAFOLDER_URL || "subcontratistas";

//TODO: Separate routing 
//TODO: send consolidated report file 
//TODO: add progress bar
//TODO: Move project to Next.js
//TODO: Rework UI 

//Serve all public files
app.use(express.static(path.join(__dirname, '/public')));



//******************************************* EJS IMPLEMENTATION *******************************************/
// Set the view engine to EJS
app.set('view engine', 'ejs');

// Define a route that renders the EJS template
app.get('/ejs', (req, res) => {
    res.render('progress', { message: 'Hello, EJS!' });

});
//*********************************************************************************************************/



if (!fs.existsSync(path.join(__dirname, uploadDestination))) {
    fs.mkdirSync(path.join(__dirname, uploadDestination), { recursive: true });
}

app.use(fileUpload());

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));

app.post("/uploadfiles", async (req, res) => {


    //Guard clause to check if the file exists
    if (!req.files || !req.files.zipFile) {
        return res.status(401).send("No file uploaded");
    }

    const zipFile = req.files.zipFile;

    // Use a unique filename to prevent overwriting
    const uniqueFilename = `${Date.now()}_${zipFile.name}`;
    const uploadedFilePath = `${uploadDestination}${uniqueFilename}`;


    // Move the uploaded file to the specified path
    zipFile.mv(uploadedFilePath, async (err) => {
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



            //? Send file to user after it has been processed
            const filePath = path.join(__dirname, "ReporteConsolidado.xlsx");

            // Set appropriate headers for file download
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="ReporteConsolidado.xlsx"`);

            // Stream the file to the response
            const fileStream = fs.createReadStream(filePath);
            fileStream.pipe(res);


            res.status(200).end()
        } catch (err) {
            console.error(err);
            //Remove all files from the folder 
            fs.rm(path.join(__dirname, uploadDestination), { recursive: true }, () => res.status(500).send("File processing failed"))
        }
    });
});



// app.get("/progress", (req, res) => {

//     res.setHeader('Content-Type', 'text/event-stream');
//     res.setHeader('Cache-Control', 'no-cache');
//     res.setHeader('Connection', 'keep-alive');

//     let progress = 0;
//     const maxProgress = 100;

//     const intervalId = setInterval(() => {
//         progress += 5; // Simulate progress (increments by 5%)
//         if (progress >= maxProgress) {
//             clearInterval(intervalId);
//             res.write('data: 100\n\n');
//             res.end();
//         } else {
//             res.write(`data: ${progress}\n\n`);
//         }
//     }, 1000);
// })






app.listen(port, () => {
    console.log(`Example app listening on port ${port}!`);

});
