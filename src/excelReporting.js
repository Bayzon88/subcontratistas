const XlsxPopulate = require('xlsx-populate');
const path = require('path');
async function writeDataToWorksheet(templatePath) {



    try {
        //Read from Reporte Consolidado File
        const reporteConsolidado = await XlsxPopulate.fromFileAsync(path.join(__dirname, "ReporteConsolidado.xlsx"))

        //Get all the data from the Reporte consolidado file
        const dataPath = reporteConsolidado.sheet("Cuadro").usedRange().value()

        //Remove the headers 
        dataPath.shift()


        // Load the existing workbook
        const workbook = await XlsxPopulate.fromFileAsync(path.join(__dirname, templatePath));

        // Access the worksheet named 'data'
        const worksheet = workbook.sheet('Cuadro');
        if (!worksheet) {
            console.log("Worksheet 'data' not found.");
            return;
        }

        //Rows
        const startRow = 2
        const lastRow = worksheet.usedRange().endCell().rowNumber();

        //Columns
        const lastColumn = 18


        //DELETE ALL DATA 
        for (let row = startRow; row < lastRow; row++) {
            for (let column = 1; column <= lastColumn; column++) {

                worksheet.row(row).cell(column).value("")
            }
        }

        //ADD ALL DATA TO THE WORKBOOK
        dataPath.forEach((row, index) => {
            let column = 0
            for (let data in row) {

                worksheet.row(index + 2).cell(column + 1).value(row[data])
                column++
            }
            // for (let column = 1; column <= lastColumn; column++) {
            //     console.log(row[column])
            // }
        })

        // Save the workbook
        const reportPatAndName = path.join(__dirname, `reportes/Reporte_Subcontratistas${getMonthAndYear()}.xlsx`)
        await workbook.toFileAsync(reportPatAndName);
        console.log("Data written successfully to worksheet 'data'.");

    } catch (error) {
        console.error("An error occurred:", error);
    }
}





const getMonthAndYear = () => {
    const date = new Date();  // 2009-11-10
    const month = date.toLocaleString('es-ES', { month: 'long' }).toUpperCase();

    const year = date.getFullYear()
    return `_${month}_${year}`;
}

module.exports = { writeDataToWorksheet }