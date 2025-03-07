// // Function to update the progress bar
// function updateProgressBar(progress) {
//     message.textContent = `Progress: ${progress}%`;
// }

// // Function to initiate the SSE connection
// function startSSE() {
//     const eventSource = new EventSource('/progress');

//     eventSource.onmessage = (event) => {
//         const progress = parseFloat(event.data);
//         updateProgressBar(progress);
//     };

//     eventSource.onerror = (error) => {
//         console.error('SSE Error:', error);
//         eventSource.close();
//     };
// }

// // Start SSE when the page loads
// window.addEventListener('load', () => {
//     startSSE();
// });



const fileInput = document.getElementById("myfiles");
const submitFiles = document.getElementById("submit-files");
const label = document.querySelector(".label-text");
const dropZone = document.querySelector("#drop-area");

/************************************ File Submission ************************************/

fileInput.addEventListener("change", (e) => {
    const selectedFile = fileInput.files[0];
    if (selectedFile) {
        label.textContent = "Archivo seleccionado: " + selectedFile.name;
        // sendFileToServer(selectedFile); // Reuse the same logic for sending the file to the server
    }
});

// Add an event listener to the submit button
submitFiles.addEventListener("click", (event) => {
    event.preventDefault(); // Prevent the default form submission behavior
    const formData = new FormData(); // Create a FormData object to hold the form data
    console.log("selecting")
    // Append the selected file to the FormData object
    const selectedFile = fileInput.files[0];
    formData.append("zipFile", selectedFile);

    //Disable button to prevent a retrigger of the button
    submitFiles.disabled = true
    // Send a POST request to the /uploadfiles endpoint with the FormData
    axios
        .post("/uploadfiles", formData)
        .then((response) => {

            //Handle Process response
            if (response.status == 200) {
                // Button to download the file.
                const downloadBtn = document.createElement("button");

                downloadBtn.textContent = "Descargar Archivo";
                downloadBtn.classList = 'btn btn-secondary'
                downloadBtn.setAttribute('id', 'btn-download')
                downloadBtn.addEventListener('click', () => downloadFile())
                btnContainer = document.querySelector('#btn-container')
                btnContainer.appendChild(downloadBtn);
            }
        })
        .catch((error) => {
            // Handle any errors that occur during download
            console.error("Error downloading file:", error);
            createRefreshPageForError()

        });
});
/**************************************************************************************/

async function downloadFile() {
    console.log("downloading file")
    axios.get("/downloadFile", { responseType: 'blob' }).then(response => {
        const blob = new Blob([response.data], { type: response.headers['content-type'] })
        const downloadURL = window.URL.createObjectURL(blob)
        const downloadElement = document.createElement("a")
        downloadElement.href = downloadURL
        console.log(downloadURL)
        downloadElement.download = `Reporte_Subcontratistas${getMonthAndYear()}.xlsx`
        downloadElement.click()

        // Revoke the Blob URL to free up resources 
        window.URL.revokeObjectURL(downloadURL);

        //Re-enable procesar button after 
        submitFiles.disabled = false;
    })

    // Revoke the Blob URL after download is initiated
    // window.URL.revokeObjectURL(url);
}

const getMonthAndYear = () => {
    const date = new Date();  // 2009-11-10
    const month = date.getMonth() - 1
    const newDate = new Date(date.getFullYear(), month, 1)
    const monthString = newDate.toLocaleString('es-ES', { month: 'long' }).toUpperCase();

    const year = monthString == 'DICIEMBRE' ? date.getFullYear() - 1 : date.getFullYear()
    return `_${monthString}_${year}`;
}

// Prevent the default behavior of the browser when files are dropped.
dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
});

// Handle file drop event.
dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    label.textContent = "Archivo seleccionado: " + e.dataTransfer.files[0].name;
    fileInput.files = e.dataTransfer.files;
});

//Refresh page on Error
const createRefreshPageForError = () => {

    // Create a button element
    const refreshButton = document.createElement("button");

    // Set button text
    refreshButton.textContent = "Error: Refresh Page";

    // Add a click event listener to refresh the page
    refreshButton.addEventListener("click", () => {
        location.reload(); // Reload the current page
    });

    // Append the button to the container or body
    document.getElementById("btn-container").appendChild(refreshButton);
}