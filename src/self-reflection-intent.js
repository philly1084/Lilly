function hasSelfReflectionUpdateIntentText(prompt = '') {
    const source = String(prompt || '').trim();
    if (!source) {
        return false;
    }

    return [
        /\bself[- ]reflection\b/i,
        /\bself[- ]reflect(?:ive)?\b/i,
        /\brecursive\s+updates?\b/i,
        /\b(full\s+hermes|hermes\s+(?:style|mode|profile|files?))\b/i,
        /\b(update|patch|revise|refresh|maintain|rewrite)\b[\s\S]{0,80}\b(soul\.?md|user\.?md|soul file|user profile)\b/i,
        /\b(update|patch|revise|refresh|maintain|rewrite)\b[\s\S]{0,80}\b(user|soul|personality|profile|agent)\s+cards?\b/i,
        /\b(user|soul|personality|profile|agent)\s+cards?\b[\s\S]{0,80}\b(update|updated|patch|revise|refresh|maintain|rewrite|grow|growing|learn|learning|evolve|evolving)\b/i,
        /\bmodel card\b[\s\S]{0,80}\b(update|reflection|learning|skill|memory|notes?)\b/i,
        /\b(update|patch|revise)\b[\s\S]{0,80}\b(skill|skills|user files?|carryover notes?|agent notes?|programming)\b/i,
        /\b(save|remember)\b[\s\S]{0,80}\b(workflow|approach|for next time|future sessions?)\b/i,
        /\bnext time\b[\s\S]{0,80}\b(skill|remember|update|notes?)\b/i,
        /\b(agents?|assistant|lilly|kimi(?:built)?)\b[\s\S]{0,80}\b(grow|growing|learn|learning|evolve|evolving|adapt|adapting)\b[\s\S]{0,80}\b(interactions?|relationship|working together|over time|future sessions?)\b/i,
        /\b(grow|growing|learn|learning|evolve|evolving|adapt|adapting)\b[\s\S]{0,80}\b(with|from|through)\b[\s\S]{0,60}\b(our|these)\s+(interactions?|conversations?|chats?)\b/i,
        /\b(make|keep|ensure)\b[\s\S]{0,80}\b(agents?|assistant|lilly|kimi(?:built)?)\b[\s\S]{0,80}\b(grow|learn|evolve|adapt)\b/i,
    ].some((pattern) => pattern.test(source));
}

module.exports = {
    hasSelfReflectionUpdateIntentText,
};
