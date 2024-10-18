const ExcelJS = require("exceljs");
(async () => {

    const workbook = new ExcelJS.Workbook();
    const file = await workbook.xlsx.readFile("Reporte_Junio_2024.xlsx")
    const worksheet = file.getWorksheet("Cuadro")
    // // worksheet.eachRow(function (row, rowNumber) {
    // //     console.log(row.values)
    // // })
    // const row = worksheet.getRow(1);
    // row.eachCell(function (cell, cellNumber) {
    //     console.log(cell.value)
    // })
    const table = worksheet.getTable("Tabla2")
    const test = table.ref
    console.log(test)

})()
