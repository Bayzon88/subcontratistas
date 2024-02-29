// Requiring the module
const reader = require("xlsx");
const fs = require("fs");
const path = require("path");
var _ = require("lodash");

let progress = 1;
function consolidateExcelFile(uploadedFileName) {
    progress = 0;
    //Variables
    let data = [];

    let dataColumns = [
        "RUC",
        "EMPRESA",
        "CONTRATISTA PRNCIPAL",
        "Nro. DNI / CE",
        "APELLIDOS Y NOMBRES",
        "FECHA NACIMIENTO",
        "TIPO TRABAJADOR",
        "TITULO DE PUESTO/CARGO",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",
        "DOMICILIO DE TRABAJADOR",
        "DISTRITO SEGÚN DNI",
        "GENERO",
        "FECHA CESE/BAJA",
        "NACIONALIDAD",
        "FECHA INICIO DE LABORES EN OBRA",
        "ESTADO",
        "TIPO DE CONTRATO LABORAL",
        "HPT"
    ];

    //TODO: Check if the file is open before starting
    let targetDir = path.join(__dirname, '/subcontratistas/' + uploadedFileName); //Folder in which all the files have been extracted
    console.log(targetDir)
    let directories = fs.readdirSync(targetDir); //Folders inside the target Directory (one for each subcontratista)

    //*********************************************************** START Main Process ***********************************************************/

    //Create the folder 
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir);
    }


    //Loop through every file in the directory, read and consolidate data into an array of objects
    directories.forEach((directory) => {
        logCurrentProgress();
        //Create path to each file inside each directory
        //! Use when the file is inside a folder
        let targetFile = path.join(targetDir, `/${directory}`);
        let dir = fs.readdirSync(targetFile);

        //Read data inside the file
        try {
            //Push data into array

            // const tempJson = readFileToJson(directory, directory); //! When file is not inside a folder
            const tempJson = readFileToJson(dir, directory);//! When file is inside a folder

            //Loop through the array and JSON, eliminate all unnecesary columns
            tempJson.forEach((jsonObject) =>
                Object.keys(jsonObject).forEach((key) => {
                    if (dataColumns.indexOf(key) == -1) {
                        delete jsonObject[key]; //Delete column not found inside dataColumns
                    }
                })
            );

            data.push(tempJson);
            let filteredData = data.filter((trabajador, index) => data.indexOf(trabajador) === index);
        } catch (exception) {
            console.log("Error with: " + directory);
            console.error(exception);
        }

        progress++;
    });

    //***************************************************************************************************************

    //Combine all JSON objects into 1 array instead of array of arrays with JSON inside
    const combinedArray = [].concat(...data);

    //Remove duplicated values
    let setWithNoDuplicates = new Set(combinedArray.map(JSON.stringify)); //Create a new Set without duplicates
    let combinedArrayWithoutDuplicates = [];
    setWithNoDuplicates.forEach((trabajador) => {
        combinedArrayWithoutDuplicates.push(JSON.parse(trabajador)); //Convert to JSON object and push to array
    });

    // Create a new Excel Object
    let newBook = reader.utils.book_new();
    let newWS = reader.utils.json_to_sheet(combinedArrayWithoutDuplicates);

    reader.utils.book_append_sheet(newBook, newWS, "Cuadro");

    /**
     * @param Workbook
     * @param String
    */
    //Write in file
    reader.writeFile(newBook, "ReporteConsolidado.xlsx");
    console.log("Proceso terminado con exito");
    deleteFilesFromDirectory(); //Cleanup function

    //************************************************************ END Main Process ************************************************************/

    //******************************************************** START Convert File to json ********************************************************/
    /**
     *
     * @param {String} fileName
     * @param {String} fileDirectory
     * @returns
     */
    function readFileToJson(fileName, fileDirectory) {
        const file = reader.readFile(`./subcontratistas/${uploadedFileName}/${fileDirectory}/${fileName}`); //! When is inside a folder
        // const file = reader.readFile(`./subcontratistas/${fileName}`); //! When is not inside a folder

        const sheets = file.SheetNames;
        //Search for "Cuadro" sheet
        const temp = reader.utils.sheet_to_json(
            file.Sheets[file.SheetNames[file.SheetNames.indexOf("Cuadro")]]
        );

        //? To review which Subcontratista is not in compliance with the file structure
        temp.forEach((sheetToChange, index, arr) => {
            arr[index] = {
                ...sheetToChange,
                errorEnArchivo: `${fileName}`,
                "CONTRATISTA PRNCIPAL": sheetToChange["CONTRATISTA PRNCIPAL"]
                    ? sheetToChange["CONTRATISTA PRNCIPAL"]
                    : sheetToChange["CONTRATISTA PRINCIPAL"],
            };
        });

        //Filter empty rows
        let personalSubcontrata = temp.filter((contratista) => contratista.Contratistas != 0);

        //TODO: Filter validation columns, keep only valid data

        personalSubcontrata.forEach((trabajador) => {
            if (typeof trabajador["TIPO TRABAJADOR"] == "string") {
                let edgeCaseTrabajadorTipo = String(trabajador["TIPO TRABAJADOR"]).toLowerCase().trim();
                switch (edgeCaseTrabajadorTipo) {
                    case "empleado":
                        trabajador["TIPO TRABAJADOR"] = 1;
                        break;
                    case "obrero de construccion civil":
                        trabajador["TIPO TRABAJADOR"] = 2;
                        break;
                    case "obrero":
                        trabajador["TIPO TRABAJADOR"] = 3;
                        break;
                    default:
                        trabajador["TIPO TRABAJADOR"] = parseInt(trabajador["TIPO TRABAJADOR"]);
                        break;
                }
            }

            //Edge cases for "Genero"
            let edgeCaseTrabajadorGenero = String(trabajador["GENERO"]).toLowerCase().trim();
            switch (edgeCaseTrabajadorGenero) {
                case 1:
                case "1":
                case "01":
                    trabajador["GENERO"] = "MASCULINO";
                    break;
                case 2:
                case "2":
                case "02":
                    trabajador["GENERO"] = "FEMENINO";
                    break;
                default:
                    trabajador["GENERO"] = edgeCaseTrabajadorGenero;
                    break;
            }

            //Edge case for Tipo de Contrato Laboral
            if (typeof trabajador["TIPO DE CONTRATO LABORAL"] == "string") {
                //Edge cases for "Genero"
                switch (trabajador["TIPO DE CONTRATO LABORAL"]) {
                    case "01":
                        trabajador["TIPO DE CONTRATO LABORAL"] = parseInt(
                            trabajador["TIPO DE CONTRATO LABORAL"]
                        );
                        break;
                    case "02":
                        trabajador["TIPO DE CONTRATO LABORAL"] = parseInt(
                            trabajador["TIPO DE CONTRATO LABORAL"]
                        );
                        break;
                    case "03":
                        trabajador["TIPO DE CONTRATO LABORAL"] = parseInt(
                            trabajador["TIPO DE CONTRATO LABORAL"]
                        );
                        break;
                    case "04":
                        trabajador["TIPO DE CONTRATO LABORAL"] = parseInt(
                            trabajador["TIPO DE CONTRATO LABORAL"]
                        );
                        break;
                    case "Planilla":
                    case "Plazo fijo":
                    case "PLAZO FIJO":
                    case "PLAZA FIJO":
                        trabajador["TIPO DE CONTRATO LABORAL"] = 1;
                        break;
                    case "Plazo indeterminado":
                    case "PLAZO INDETERMINADO":
                        trabajador["TIPO DE CONTRATO LABORAL"] = 2;
                        break;

                    case "SI":
                    case "SIN CONTRATO REGIMEN CIVIL":
                    case "Sin contrato regimen civil":
                        trabajador["TIPO DE CONTRATO LABORAL"] = 4;
                        break;
                    default:
                        trabajador["TIPO DE CONTRATO LABORAL"] = parseInt(
                            trabajador["TIPO DE CONTRATO LABORAL"]
                        );
                        break;
                }
            }

            //Edge cases for Estado
            if (typeof trabajador["ESTADO"] == "string") {
                let edgeCaseTrabajadorEstado = String(trabajador["ESTADO"]).toLowerCase().trim();

                switch (edgeCaseTrabajadorEstado) {
                    case "activo":
                        trabajador.ESTADO = 1;
                        break;
                    case "activo en obra":
                        trabajador.ESTADO = 1;
                        break;
                    case "cesado":
                        trabajador.ESTADO = 2;
                        break;
                    case "reten":
                        trabajador.ESTADO = 3;
                        break;
                    default:
                        trabajador.ESTADO = parseInt(trabajador.ESTADO);
                        break;
                }
            }
        });

        return personalSubcontrata;
    }
    //********************************************************* END Convert File to json *********************************************************/





    //********************************************************** START Delete all files *********************************************************/
    function deleteFilesFromDirectory() {
        //Cleanup function to remove all files from the directory once the consolidation process is finished
        try {
            fs.rm(targetDir, { recursive: true }, () => console.log("All files deleted"))
        }
        catch (exception) {
            console.error("Error removing files from folder")

        }

    }
    //*********************************************************** END Delete all files **********************************************************/

    function logCurrentProgress() {
        // if (progress >= directories.length) progress = 0
        //Log Progress
        console.clear();
        console.log(
            `Progress : ${Number.parseFloat(progress / directories.length).toLocaleString(undefined, {
                style: "percent",
                minimumFractionDigits: 2,
            })}`
        );
    }


};

function getCurrentProgress() {
    return { progress: progress }
}

module.exports = { getCurrentProgress: getCurrentProgress, consolidateExcelFile: consolidateExcelFile }; //
