// //Test overwriting information inside Formato de Reporte

// //Delete previous content in "Cuadro" sheet, only remove from RUC to Contrato Laboral
// //Read files from uploaded ZIP file and paste it in Cuadro sheet
// //Save a temporary file with a different name
// //Send the file to the client
// //Delete the temporary file


// //******************* TESTING ********************/
// //Call Google Sheets function when the consolidation finishes
// //Upload template to google sheets project - OK

// //Import Libraries
// require("dotenv").config(); //Load the .env file
// const fs = require('fs').promises;
// const path = require('path');
// const { google } = require('googleapis')


// async function connectToGoogleSheetsAPI() {

//     // // If modifying these scopes, delete token.json.
//     // const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
//     // // The file token.json stores the user's access and refresh tokens, and is
//     // // created automatically when the authorization flow completes for the first
//     // // time.
//     // const TOKEN_PATH = path.join(process.cwd(), 'token.json');
//     // const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

//     // /**
//     //  * Reads previously authorized credentials from the save file.
//     //  *
//     //  * @return {Promise<OAuth2Client|null>}
//     //  */
//     // async function loadSavedCredentialsIfExist() {
//     //     try {
//     //         const content = await fs.readFile(TOKEN_PATH);
//     //         const credentials = JSON.parse(content);
//     //         return google.auth.fromJSON(credentials);

//     //     } catch (err) {
//     //         console.log(err)
//     //         return null;
//     //     }
//     // }

//     // loadSavedCredentialsIfExist()

//     const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
//     console.log(path.join(__dirname, 'credentials.json'))



//     const auth = new google.auth.GoogleAuth({
//         keyFile: path.join(__dirname, 'credentials.json'),
//         scopes: process.env.SCOPES,
//     })


//     //    Create client object
//     const client = await auth.getClient();
//     const spreadsheetId = '1EemWMWpYA1fGufSR-Eq9V-2FicFZ_hykQmNTbZYQCCk'
//     //Instance of google sheets API
//     const googleSheets = google.sheets({ version: "v4", auth: client })
//     try {

//         const data = await googleSheets.spreadsheets.get({
//             // auth: auth,
//             key: 'AIzaSyA8ZyN8UbBef6k5gZvj9Lg4lpWt792JFhI',
//             spreadsheetId: spreadsheetId

//         })
//     } catch (e) {


//         console.log(e)
//     }
// }

// connectToGoogleSheetsAPI();
// //Connect to Google Sheets API
// //Remove all values in the data sheet
// //append all information in data sheet
// //Send the file to the user using fetch or axios