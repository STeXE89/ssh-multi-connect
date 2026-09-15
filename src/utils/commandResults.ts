/**
 * Turning the output of one command run on many hosts into something readable.
 *
 * The point of running a command everywhere is usually to find the host that
 * disagrees, so identical output is collapsed into a single block naming the
 * hosts that produced it, and anything unusual is listed first.
 */

/** What one host did with the command. */
export interface CommandResult {
    /** The host's label, as shown in the tree. */
    host: string;
    stdout: string;
    stderr: string;
    /** The exit status, or undefined when the command never ran. */
    code?: number;
    /** Set when the command could not be run at all. */
    error?: string;
}

/** Hosts that produced the same output. */
export interface ResultGroup {
    hosts: string[];
    stdout: string;
    stderr: string;
    code?: number;
    error?: string;
}

/**
 * Groups hosts whose output is identical.
 *
 * Groups come back with the failures first, then the smallest groups: the odd
 * host out is what the run was for, so it should not be at the bottom of a
 * long report. Hosts keep their given order inside a group.
 *
 * @param results One entry per host.
 * @returns The groups, most interesting first.
 */
export function groupResults(results: CommandResult[]): ResultGroup[] {
    const groups = new Map<string, ResultGroup>();

    for (const result of results) {
        const key = JSON.stringify([result.stdout, result.stderr, result.code ?? null, result.error ?? null]);
        const existing = groups.get(key);

        if (existing) {
            existing.hosts.push(result.host);
            continue;
        }

        groups.set(key, {
            hosts: [result.host],
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            error: result.error,
        });
    }

    return [...groups.values()].sort((a, b) => {
        const byOutcome = Number(succeeded(a)) - Number(succeeded(b));
        return byOutcome !== 0 ? byOutcome : a.hosts.length - b.hosts.length;
    });
}

/**
 * Whether a group's command did what was asked.
 *
 * @param group The group.
 * @returns True when it ran and exited zero.
 */
export function succeeded(group: ResultGroup | CommandResult): boolean {
    return group.error === undefined && group.code === 0;
}

/**
 * Renders a run as a plain-text report.
 *
 * @param command The command that was run.
 * @param results One entry per host.
 * @returns The report.
 */
export function renderReport(command: string, results: CommandResult[]): string {
    const groups = groupResults(results);
    const failures = results.filter(result => !succeeded(result)).length;

    const header = [
        `$ ${command}`,
        '',
        `${results.length} host(s), ${groups.length} distinct result(s)` + (failures > 0 ? `, ${failures} failed` : ''),
    ];

    return [...header, '', ...groups.map(renderGroup)].join('\n');
}

/**
 * Renders one group.
 *
 * @param group The group.
 * @returns Its block of the report.
 */
function renderGroup(group: ResultGroup): string {
    const status = group.error ? `could not run: ${group.error}` : `exit ${group.code ?? '?'}`;
    const lines = [`${'='.repeat(60)}`, `${group.hosts.join(', ')}  [${status}]`, ''];

    if (group.stdout.trim()) {
        lines.push(group.stdout.replace(/\n+$/, ''), '');
    }

    if (group.stderr.trim()) {
        lines.push(
            ...group.stderr
                .replace(/\n+$/, '')
                .split('\n')
                .map(line => `stderr| ${line}`),
            ''
        );
    }

    if (!group.stdout.trim() && !group.stderr.trim() && !group.error) {
        lines.push('(no output)', '');
    }

    return lines.join('\n');
}
