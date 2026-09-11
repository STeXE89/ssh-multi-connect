const vscode = acquireVsCodeApi();

// Listen for updates from the extension
window.addEventListener('message', event => {
    const { connections } = event.data;
    if (!connections) {
        return;
    }

    // Built with new Option() rather than innerHTML: a host alias or user name
    // coming from ssh_config would otherwise be parsed as HTML.
    const select = document.getElementById('connections');
    select.replaceChildren(...connections.map(conn => new Option(`${conn.user}@${conn.host}`, conn.id)));
    updateSendButtonState();
});

const sendButton = document.getElementById('send');
const connectionsSelect = document.getElementById('connections');
const commandInput = document.getElementById('command');

function updateSendButtonState() {
    const selectedConnections = Array.from(connectionsSelect.selectedOptions).map(option => option.value);
    const command = commandInput.value.trim();
    sendButton.disabled = selectedConnections.length === 0 || !command;
}

connectionsSelect.addEventListener('change', updateSendButtonState);
commandInput.addEventListener('input', updateSendButtonState);

function sendCommand() {
    const selectedConnections = Array.from(connectionsSelect.selectedOptions).map(option => option.value);
    const command = commandInput.value;
    if (selectedConnections.length === 0 || !command.trim()) {
        return;
    }

    vscode.postMessage({ command, selectedConnections });
    commandInput.value = '';
    updateSendButtonState();
}

sendButton.addEventListener('click', sendCommand);

// Enter in the command box does the same thing as pressing Send.
commandInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCommand();
    }
});

// Initialize the button state
updateSendButtonState();
