const vscode = acquireVsCodeApi();

// Listen for updates from the extension
window.addEventListener('message', (event) => {
    const { command, connections } = event.data;
    if (connections) {
        const connectionsSelect = document.getElementById('connections');
        connectionsSelect.innerHTML = connections.map(conn => 
            `<option value="${conn.id}">${conn.user}@${conn.host}</option>`
        ).join('');
    }
});

const sendButton = document.getElementById('send');
const connectionsSelect = document.getElementById('connections');
const commandInput = document.getElementById('command');

function updateSendButtonState() {
    const selectedConnections = Array
        .from(connectionsSelect.selectedOptions)
        .map(option => option.value);
    const command = commandInput.value.trim();
    sendButton.disabled = (selectedConnections.length === 0 || !command);
}

connectionsSelect.addEventListener('change', updateSendButtonState);
commandInput.addEventListener('input', updateSendButtonState);

document.getElementById('send').addEventListener('click', () => {
    const selectedConnections = Array
        .from(connectionsSelect.selectedOptions)
        .map(option => option.value);
    const command = commandInput.value;
    vscode.postMessage({ command, selectedConnections });
    commandInput.value = '';
    updateSendButtonState();
});

// Initialize the button state
updateSendButtonState();