const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWebCliPromptHelpers() {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /const app = new CodeCLIApp\(\);\s*window\.app = app;\s*$/,
            'module.exports = { formatWebCliSkillTaskPrompt };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports;
}

describe('web-cli skill prompt formatting', () => {
    const { formatWebCliSkillTaskPrompt } = loadWebCliPromptHelpers();

    test('separates skill routing instruction from the user task', () => {
        expect(formatWebCliSkillTaskPrompt('imagegen', 'Create three product hero options.')).toBe(
            'Use the `imagegen` skill for this task.\n\nCreate three product hero options.'
        );
    });

    test('stages a clear editable placeholder instead of a dangling colon', () => {
        expect(formatWebCliSkillTaskPrompt('github:yeet', '')).toBe(
            'Use the `github:yeet` skill for this task.\n\nDescribe the task here.'
        );
    });
});
