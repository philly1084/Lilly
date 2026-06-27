const OutputManager = require('./output');

function createElement() {
    return {
        value: '',
        style: {},
        attributes: {},
        focus: jest.fn(),
        select: jest.fn(),
        setSelectionRange: jest.fn(),
        setAttribute: jest.fn(function setAttribute(name, value) {
            this.attributes[name] = value;
        }),
    };
}

describe('notation OutputManager clipboard copy', () => {
    const originalNavigator = global.navigator;
    const originalDocument = global.document;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;

    beforeEach(() => {
        OutputManager.currentResult = 'expanded notation result';
        console.error = jest.fn();
        console.warn = jest.fn();
    });

    afterEach(() => {
        global.navigator = originalNavigator;
        global.document = originalDocument;
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        jest.restoreAllMocks();
    });

    test('uses Clipboard API when available', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        global.navigator = { clipboard: { writeText } };
        global.document = {
            createElement: jest.fn(),
            body: {
                appendChild: jest.fn(),
                removeChild: jest.fn(),
            },
            execCommand: jest.fn(),
        };

        await expect(OutputManager.copyToClipboard()).resolves.toBe(true);

        expect(writeText).toHaveBeenCalledWith('expanded notation result');
        expect(global.document.createElement).not.toHaveBeenCalled();
        expect(global.document.execCommand).not.toHaveBeenCalled();
    });

    test('falls back when Clipboard API rejects', async () => {
        const textarea = createElement();
        const writeText = jest.fn().mockRejectedValue(new Error('NotAllowedError'));
        global.navigator = { clipboard: { writeText } };
        global.document = {
            createElement: jest.fn(() => textarea),
            body: {
                appendChild: jest.fn(),
                removeChild: jest.fn(),
            },
            execCommand: jest.fn(() => true),
        };

        await expect(OutputManager.copyToClipboard()).resolves.toBe(true);

        expect(writeText).toHaveBeenCalledWith('expanded notation result');
        expect(global.document.createElement).toHaveBeenCalledWith('textarea');
        expect(global.document.execCommand).toHaveBeenCalledWith('copy');
        expect(global.document.body.removeChild).toHaveBeenCalledWith(textarea);
        expect(console.warn).toHaveBeenCalledWith(
            'Clipboard API copy failed, trying fallback:',
            expect.any(Error),
        );
    });

    test('falls back to a temporary textarea when Clipboard API is unavailable', async () => {
        const textarea = createElement();
        const appended = [];
        global.navigator = {};
        global.document = {
            createElement: jest.fn(() => textarea),
            body: {
                appendChild: jest.fn((element) => {
                    appended.push(element);
                    return element;
                }),
                removeChild: jest.fn((element) => {
                    const index = appended.indexOf(element);
                    if (index >= 0) appended.splice(index, 1);
                    return element;
                }),
            },
            execCommand: jest.fn(() => true),
        };

        await expect(OutputManager.copyToClipboard()).resolves.toBe(true);

        expect(global.document.createElement).toHaveBeenCalledWith('textarea');
        expect(textarea.value).toBe('expanded notation result');
        expect(textarea.setAttribute).toHaveBeenCalledWith('readonly', '');
        expect(textarea.style.position).toBe('fixed');
        expect(textarea.focus).toHaveBeenCalled();
        expect(textarea.select).toHaveBeenCalled();
        expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, textarea.value.length);
        expect(global.document.execCommand).toHaveBeenCalledWith('copy');
        expect(global.document.body.removeChild).toHaveBeenCalledWith(textarea);
        expect(appended).toEqual([]);
    });
});
