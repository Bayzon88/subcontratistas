// Function to update the progress bar
function updateProgressBar(progress) {
    message.textContent = `Progress: ${progress}%`;
}

// Function to initiate the SSE connection
function startSSE() {
    const eventSource = new EventSource('/progress');

    eventSource.onmessage = (event) => {
        const progress = parseFloat(event.data);
        updateProgressBar(progress);
    };

    eventSource.onerror = (error) => {
        console.error('SSE Error:', error);
        eventSource.close();
    };
}

// Start SSE when the page loads
window.addEventListener('load', () => {
    startSSE();
});