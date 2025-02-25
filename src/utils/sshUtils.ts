import * as vscode from 'vscode';
import * as os from 'os';
import { exec } from 'child_process';

export function checkAndInstallSshpass() {
    exec('sshpass -V', (error) => {
        if (error) {
            vscode.window.showWarningMessage('sshpass is not installed. Do you want to install it?', 'Yes', 'No').then(selection => {
                if (selection === 'Yes') {
                    const platform = os.platform();
                    let installCommand = '';

                    if (platform === 'linux') {
                        exec('cat /etc/*-release', (releaseError, stdout) => {
                            if (releaseError) {
                                vscode.window.showErrorMessage('Failed to detect Linux distribution.');
                                return;
                            }

                            if (stdout.includes('Ubuntu') || stdout.includes('Debian')) {
                                installCommand = 'sudo apt-get install -y sshpass';
                            } else if (stdout.includes('Arch')) {
                                installCommand = 'sudo pacman -S --noconfirm sshpass';
                            } else if (stdout.includes('Red Hat') || stdout.includes('CentOS') || stdout.includes('Fedora')) {
                                installCommand = 'sudo yum install -y sshpass';
                            } else {
                                vscode.window.showErrorMessage('sshpass installation is not supported on this Linux distribution.');
                                return;
                            }

                            const terminal = vscode.window.createTerminal('Install sshpass');
                            terminal.show();
                            terminal.sendText(installCommand);
                        });
                    } else {
                        vscode.window.showErrorMessage('sshpass installation is not supported on this OS.');
                    }
                }
            });
        }
    });
}