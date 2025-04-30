import * as vscode from 'vscode';
import * as path from 'path';

let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Sets the extension context during activation.
 * @param context - The extension context provided by VS Code.
 */
export function setExtensionContext(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

/**
 * Retrieves the extension path from the context.
 * Throws an error if the context is not set.
 * @returns The extension path.
 */
export function getExtensionPath(): string {
    if (!extensionContext) {
        throw new Error('Extension context is not set. Ensure setExtensionContext is called during activation.');
    }
    return extensionContext.extensionPath;
}

/**
 * Generates a full path to a file in the extension's directory.
 * @param relativePath - The relative path to the file from the extension root.
 * @returns The full path to the file.
 */
function getFilePath(relativePath: string): string {
    return path.join(getExtensionPath(), relativePath);
}

// Paths to webview resources
export const MULTICOMMANDPANEL_HTML_PATH = () => getFilePath('resources/media/webviews/multiCommandPanel.html');
export const MULTICOMMANDPANEL_CSS_PATH = () => getFilePath('resources/media/webviews/multiCommandPanel.css');
export const MULTICOMMANDPANEL_JS_PATH = () => getFilePath('resources/media/webviews/multiCommandPanel.js');