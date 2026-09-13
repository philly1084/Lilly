'use strict';
function traceToolDispatch(dispatch, { trace, agentId, now, onDispatch = () => {} }) {
  return async (name, args, meta) => {
    onDispatch();
    const entry = { agentId, name, startedMs: now() }; trace.push(entry);
    try { const result = await dispatch(name, args, meta); entry.finishedMs = now(); entry.ok = true; return result; }
    catch (error) { entry.ok = false; entry.code = error.code || 'tool_failed'; throw error; }
  };
}
module.exports = { traceToolDispatch };
