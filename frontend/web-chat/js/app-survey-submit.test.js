const fs = require('fs');
const path = require('path');

describe('web-chat survey submit flow', () => {
    test('releases the pending checkpoint gate before clearing pending state', () => {
        const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
        const methodMatch = source.match(/async submitAgentSurvey\(trigger\) \{[\s\S]*?\n    \}/);

        expect(methodMatch).toBeTruthy();

        const methodSource = methodMatch[0];
        const releaseIndex = methodSource.indexOf('this.releasePendingSurveyProcessingGate(sessionId, surveyId);');
        const answeredIndex = methodSource.indexOf('this.markLocalCheckpointAnswered(');
        const sendIndex = methodSource.indexOf('await this.sendPreparedMessage(responseContent);');

        expect(releaseIndex).toBeGreaterThan(-1);
        expect(answeredIndex).toBeGreaterThan(-1);
        expect(sendIndex).toBeGreaterThan(-1);
        expect(releaseIndex).toBeLessThan(answeredIndex);
        expect(answeredIndex).toBeLessThan(sendIndex);
    });
});
