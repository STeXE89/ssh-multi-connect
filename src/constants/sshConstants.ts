import * as path from 'path';
import * as os from 'os';

export const SSH_CONFIG_DIR = path.join(os.homedir(), '.ssh');
export const SSH_CONFIG_PATH = path.join(SSH_CONFIG_DIR, 'config');
export const SSH_KNOWN_HOSTS_PATH = path.join(SSH_CONFIG_DIR, 'known_hosts');
export const SSH_DEFAULT_PORT = 22;