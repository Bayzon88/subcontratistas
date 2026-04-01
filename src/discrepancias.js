const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
function encontrarDiscrepancias() {
    //Lee un folder y todos los folders dentro de el, luego abre el archivo excel de cada uno de ellos y lee la columna llamada "SUBCONTRATISTA" y devuelve un json con el nombre del subcontratista, el nombre de la carpeta y boolean si son iguales o no 
    const subcontratistasPath = path.join(__dirname, "subcontratistas");
    const subcontratistasFolders = fs.readdirSync(subcontratistasPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
    const discrepancies = [];
    subcontratistasFolders.forEach(folder => {
        const folderPath = path.join(subcontratistasPath, folder);
        const files = fs.readdi
        "ga/rSync(folderPath);
        files.forEach(file => {
            if (file.endsWith('.xlsx')) {
                const filePath = path.join(folderPath, file);
                const workbook = xlsx.readFile(filePath);
                const sheetName = workbook.SheetNames[1];
                const worksheet = workbook.Sheets[sheetName];
                const subcontratistaCell = worksheet['C3']; // Assuming 'SUBCONTRATISTA' is in cell C3
                const subcontratistaName = subcontratistaCell ? subcontratistaCell.v : '';
                discrepancies.push({
                    subcontratista: subcontratistaName,
                    folder: folder,
                    isEqual: subcontratistaName === folder
                });
            }
        });
    });
    return discrepancies;
}

console.log(encontrarDiscrepancias())