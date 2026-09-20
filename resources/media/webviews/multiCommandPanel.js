const vscode = acquireVsCodeApi();

// Listen for updates from the extension
window.addEventListener('message', event => {
    const { connections, splitTerminals, history } = event.data;

    // Offered as native suggestions on the input, so the commands run across
    // hosts do not have to be retyped every time.
    if (history) {
        historyList.replaceChildren(...history.map(command => new Option(command)));
    }

    // The setting can change from the settings editor too, so the panel is
    // told the current value rather than remembering its own.
    if (splitTerminals !== undefined) {
        splitToggle.checked = splitTerminals;
        describeSplit();
    }

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
const splitToggle = document.getElementById('split');
const historyList = document.getElementById('history');
const splitHint = document.getElementById('split-hint');

function describeSplit() {
    splitHint.textContent = splitToggle.checked
        ? 'A pane per selected host, side by side.'
        : "Each host's own terminal, as they already are.";
}

splitToggle.addEventListener('change', () => {
    describeSplit();
    vscode.postMessage({ type: 'splitTerminals', value: splitToggle.checked });
});

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

    vscode.postMessage({ type: 'send', command, selectedConnections });
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
