import * as assert from 'assert';
import { groupResults, renderReport, succeeded, CommandResult } from '../utils/commandResults';
import { resultsDocumentName } from '../commandResultsDocument';

const ok = (host: string, stdout: string): CommandResult => ({ host, stdout, stderr: '', code: 0 });

suite('commandResults: grouping', () => {
    test('collapses hosts that said the same thing', () => {
        const groups = groupResults([ok('a', 'up'), ok('b', 'up'), ok('c', 'up')]);

        assert.strictEqual(groups.length, 1);
        assert.deepStrictEqual(groups[0].hosts, ['a', 'b', 'c']);
    });

    test('keeps hosts that differ apart', () => {
        const groups = groupResults([ok('a', 'up'), ok('b', 'down')]);

        assert.strictEqual(groups.length, 2);
    });

    test('puts the odd host out first, which is what the run was for', () => {
        const groups = groupResults([ok('a', 'up'), ok('b', 'up'), ok('c', 'up'), ok('odd', 'down')]);

        assert.deepStrictEqual(groups[0].hosts, ['odd']);
    });

    test('puts failures ahead of successes, however few', () => {
        const groups = groupResults([{ host: 'broken', stdout: '', stderr: 'no such file', code: 1 }, ok('a', 'up')]);

        assert.deepStrictEqual(groups[0].hosts, ['broken']);
    });

    test('a different exit status is a different result, even with the same output', () => {
        const groups = groupResults([
            { host: 'a', stdout: 'x', stderr: '', code: 0 },
            { host: 'b', stdout: 'x', stderr: '', code: 1 },
        ]);

        assert.strictEqual(groups.length, 2);
    });

    test('a host that could not run the command is not a success', () => {
        assert.ok(!succeeded({ host: 'a', stdout: '', stderr: '', error: 'channel refused' }));
        assert.ok(!succeeded({ host: 'a', stdout: '', stderr: '', code: 2 }));
        assert.ok(succeeded(ok('a', '')));
    });
});

suite('commandResults: the report', () => {
    test('leads with the command and a count', () => {
        const report = renderReport('uptime', [ok('a', 'up'), ok('b', 'up')]);

        assert.ok(report.startsWith('$ uptime\n'));
        assert.ok(report.includes('2 host(s), 1 distinct result(s)'));
    });

    test('counts the failures', () => {
        const report = renderReport('uptime', [ok('a', 'up'), { host: 'b', stdout: '', stderr: 'x', code: 1 }]);

        assert.ok(report.includes('2 failed') === false);
        assert.ok(report.includes('1 failed'));
    });

    test('names every host in a group', () => {
        const report = renderReport('uptime', [ok('a', 'up'), ok('b', 'up')]);

        assert.ok(report.includes('a, b  [exit 0]'));
    });

    test('marks stderr so it cannot be mistaken for output', () => {
        const report = renderReport('ls', [{ host: 'a', stdout: '', stderr: 'no such file', code: 2 }]);

        assert.ok(report.includes('stderr| no such file'));
        assert.ok(report.includes('[exit 2]'));
    });

    test('says so when a host produced nothing', () => {
        assert.ok(renderReport('true', [ok('a', '')]).includes('(no output)'));
    });

    test('explains a host that could not run it', () => {
        const report = renderReport('uptime', [{ host: 'a', stdout: '', stderr: '', error: 'channel refused' }]);

        assert.ok(report.includes('could not run: channel refused'));
    });
});

suite('resultsDocumentName', () => {
    test('names the tab after the command', () => {
        assert.strictEqual(resultsDocumentName('uptime'), 'uptime.log');
    });

    test('shortens a long pipeline', () => {
        const name = resultsDocumentName('a'.repeat(100));

        assert.ok(name.length < 50);
        assert.ok(name.endsWith('....log'));
    });

    test('keeps separators out of the path', () => {
        assert.ok(!resultsDocumentName('cat /etc/hosts').includes('/'));
    });

    test('falls back to a name when the command is only whitespace', () => {
        assert.strictEqual(resultsDocumentName('   '), 'command.log');
    });
});
