const XlsxPopulate = require('xlsx-populate');

async function writeDataToWorksheet(templatePath, dataPath) {
    console.table(dataPath[0])

    try {
        // Load the existing workbook
        const workbook = await XlsxPopulate.fromFileAsync(workbookPath);

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



        // Save the workbook

        const reportPatAndName = `./Reporte_Subcontratistas_${getMonthAndYear()}.xlsx`
        await workbook.toFileAsync(reportPatAndName);
        console.log("Data written successfully to worksheet 'data'.");

    } catch (error) {
        console.error("An error occurred:", error);
    }
}

// Usage example
const data = [
    ['RUC1', 'EMPRESA1', 'CONTRATISTA1', 'DNI1', 'NOMBRES1', '2023-01-01', 'TIPO1', 'PUESTO1', 'OBRA1', 'DOMICILIO1', 'DISTRITO1', 'M', '2023-12-31', 'PERU', '2023-01-01', 'ACTIVO', 'INDEFINIDO', 'HPT1'],
    ['RUC2', 'EMPRESA2', 'CONTRATISTA2', 'DNI2', 'NOMBRES2', '1980-05-15', 'TIPO2', 'PUESTO2', 'OBRA2', 'DOMICILIO2', 'DISTRITO2', 'F', '', 'PERU', '2022-06-01', 'INACTIVO', 'TEMPORAL', 'HPT2'],
    // Add more rows as needed
];



const getMonthAndYear = () => {
    const date = new Date();  // 2009-11-10
    const month = date.toLocaleString('es-ES', { month: 'long' }).toUpperCase();

    const year = date.getFullYear()
    return `_${month}_${year}`;
}

module.exports = { writeDataToWorksheet }