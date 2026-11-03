// A legacy pre-step hook may deliver a local reply by opening/closing a step
// itself. Admit that through the HOST's existing system-head projection and
// stop the native driver from opening the same step a second time. No plugin
// policy, message text, model request or tool permissions are changed.
export async function runCompatiblePreStep(session, position, run, projectHead, handled) {
  const descriptor = Object.getOwnPropertyDescriptor(session, 'append');
  const original = session.append;
  const append = (type, data, intent) => original.call(session, type, data, intent);
  const pending = [];
  let opened = false,
    closed = false;
  const boundary = (data) => {
    if (data?.turn !== position.turn || data?.step !== position.step)
      throw new Error('Pre-step hook attempted a foreign execution boundary.');
  };
  session.append = function (type, data, intent) {
    if (type === 'user/message' && !opened) {
      // The legacy hook does not consume append's return value. Delay these
      // messages so the original native system head remains the first surface.
      pending.push([type, data, intent]);
      return;
    }
    if (type === 'step/start') {
      boundary(data);
      if (opened) throw new Error('Pre-step hook opened the same step twice.');
      const event = append(type, data, intent);
      opened = true;
      projectHead(append);
      for (const args of pending.splice(0)) append(...args);
      return event;
    }
    if (type === 'step/end') {
      boundary(data);
      if (!opened || closed) throw new Error('Pre-step hook closed an unowned execution step.');
      const event = append(type, data, intent);
      closed = true;
      return event;
    }
    return append(type, data, intent);
  };
  try {
    const decision = await run();
    if (opened) {
      // Native reject terminates the turn normally with its blocked reason.
      // The hook's actual reply is already persisted; no second LLM call.
      return { kind: 'reject' };
    }
    if (pending.length) throw new Error('A pre-step hook wrote messages without owning a step.');
    return decision;
  } finally {
    if (descriptor) Object.defineProperty(session, 'append', descriptor);
    else delete session.append;
    if (opened) {
      try {
        if (!closed) append('step/end', { turn: position.turn, step: position.step });
      } finally {
        handled();
      }
    }
  }
}

// A versioned, explicit repair for the corresponding legacy artifact shape.
// Keep every event and all content; move the EXISTING system head ahead of the
// first surface, repair step coordinates, and map only known event references.
// The caller must run native strict restore/relationship validation afterwards.
export function repairLegacyPreStepArtifact(artifact) {
  if (artifact.header.version !== 4 || artifact.inheritedEventCount !== 0)
    throw new Error('Unsupported legacy pre-step history; original retained.');
  const events = structuredClone(artifact.events);
  const firstSurface = events.findIndex((e) =>
    ['system/message', 'user/message', 'assistant/message', 'developer/message', 'tool/result'].includes(
      e.type,
    ),
  );
  const firstStart = events.findIndex((e) => e.type === 'step/start');
  const firstEnd = events.findIndex((e) => e.type === 'step/end');
  const head = events.findIndex((e) => e.type === 'system/message');
  const duplicate = events.findIndex((e, i) => i > firstEnd && e.type === 'step/start');
  if (
    firstSurface < 0 ||
    firstSurface >= firstStart ||
    firstStart >= firstEnd ||
    duplicate < 0 ||
    head <= duplicate ||
    events[firstSurface].type !== 'user/message' ||
    events[firstStart].data.step !== 1 ||
    events[duplicate].data.step !== 1 ||
    events[firstStart].data.turn !== events[duplicate].data.turn ||
    !events.slice(firstStart, firstEnd).some((e) => e.type === 'assistant/message') ||
    events.some(
      (e) =>
        e.type.startsWith('compaction/') ||
        e.type.startsWith('tool/ptc-') ||
        e.type.startsWith('subagent/') ||
        e.type === 'session/title-llm-request',
    )
  )
    throw new Error('History does not match the bounded legacy pre-step shape; original retained.');
  const startEvent = events[firstStart],
    headEvent = events[head];
  if (headEvent.surfaceOp !== 'append')
    throw new Error('Legacy head is not a simple append; original retained.');
  const reordered = events.filter((e) => e !== startEvent && e !== headEvent);
  reordered.splice(firstSurface, 0, startEvent, headEvent);
  const map = new Map(reordered.map((e, i) => [e.seq, i]));
  const ref = (value) => {
    if (!map.has(value)) throw new Error('Unknown historical event reference; original retained.');
    return map.get(value);
  };
  let step = null,
    count = 0;
  for (const [seq, event] of reordered.entries()) {
    event.seq = seq;
    if (event.type === 'turn/start') {
      count = 0;
      step = null;
    }
    if (event.type === 'step/start') step = ++count;
    if (step !== null && Object.hasOwn(event.data, 'step')) event.data.step = step;
    if (event.type === 'step/end') step = null;
    if (event.sourceEventSeqs) event.sourceEventSeqs = event.sourceEventSeqs.map(ref);
    if (event.surfaceOp && typeof event.surfaceOp === 'object') {
      event.surfaceOp.startSeq = ref(event.surfaceOp.startSeq);
      event.surfaceOp.endSeq = ref(event.surfaceOp.endSeq);
    }
    if (Array.isArray(event.data.messageSeqs)) event.data.messageSeqs = event.data.messageSeqs.map(ref);
    if (Object.hasOwn(event.data, 'headerSeq')) event.data.headerSeq = ref(event.data.headerSeq);
  }
  return { ...structuredClone(artifact), events: reordered };
}
