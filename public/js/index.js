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
// Add an event listener to the submit button
submitFiles.addEventListener("click", (event) => {
    event.preventDefault(); // Prevent the default form submission behavior
    const formData = new FormData(); // Create a FormData object to hold the form data

    // Append the selected file to the FormData object
    const selectedFile = fileInput.files[0];
    formData.append("zipFile", selectedFile);

    // Send a POST request to the /uploadfiles endpoint with the FormData
    axios
        .post("/uploadfiles", formData)
        .then((response) => {
            // Handle the download response
            console.log("File download initiated");

            // BLOB Object with the response from the server (File)
            const blob = new Blob([response.data], { type: "application/octet-stream" });

            // Create a URL for the Blob object
            const url = window.URL.createObjectURL(blob);

            // Create Anchor element to prompt the user to download the file
            const a = document.createElement("a");
            // a.style.display = "none";
            a.textContent = "HOLA";
            a.href = url;

            // Set the filename for the download
            a.download = "ReporteConsolidado.xlsx";

            // Add the anchor element to the document
            document.body.appendChild(a);

            // Revoke the Blob URL to free up resources
            window.URL.revokeObjectURL(url);
        })
        .catch((error) => {
            // Handle any errors that occur during download
            console.error("Error downloading file:", error);
        });
});
/**************************************************************************************/

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