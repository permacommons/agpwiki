export const createDiscussionState = ({ threadOrder, page = 1, pageSize }, restored = null) => {
  const order = [...(restored?.threadOrder ?? threadOrder)];
  const loadedStart = restored?.loadedStart ?? (page - 1) * pageSize;
  return {
    threadOrder: order,
    pageSize,
    loadedStart,
    loadedEnd: restored?.loadedEnd ?? Math.min(loadedStart + pageSize, order.length),
    automatic: restored?.automatic ?? true,
    loadedNewer: restored?.loadedNewer ?? false,
    status: 'idle',
    pending: null,
  };
};

export const discussionControls = state => {
  const atStart = state.loadedStart === 0;
  const atEnd = state.loadedEnd === state.threadOrder.length;
  const busy = state.pending !== null;
  return {
    newer: { busy, exhausted: atStart, showBoundary: state.loadedNewer && atStart },
    older: { busy, exhausted: atEnd, showBoundary: atEnd },
    showAutomatic: !atEnd,
    rangeStart: state.threadOrder.length ? state.loadedStart + 1 : 0,
    rangeEnd: state.loadedEnd,
    total: state.threadOrder.length,
  };
};

export const beginDiscussionLoad = (state, direction) => {
  if (state.pending || !['newer', 'older'].includes(direction)) return null;
  const newer = direction === 'newer';
  if (newer ? state.loadedStart === 0 : state.loadedEnd === state.threadOrder.length) return null;
  const start = newer ? Math.max(0, state.loadedStart - state.pageSize) : state.loadedEnd;
  const end = newer ? state.loadedStart : Math.min(state.threadOrder.length, state.loadedEnd + state.pageSize);
  return {
    ...state,
    status: 'loading',
    pending: { direction, start, end, threadIds: state.threadOrder.slice(start, end) },
  };
};

export const finishDiscussionLoad = (state, succeeded) => {
  if (!state.pending) return state;
  if (!succeeded) return { ...state, pending: null, status: 'error', automatic: false };
  const { direction, start, end } = state.pending;
  return {
    ...state,
    loadedStart: direction === 'newer' ? start : state.loadedStart,
    loadedEnd: direction === 'older' ? end : state.loadedEnd,
    loadedNewer: state.loadedNewer || direction === 'newer',
    status: 'idle',
    pending: null,
  };
};

export const readDiscussionSnapshot = (serialized, pageSize) => {
  try {
    const snapshot = JSON.parse(serialized);
    if (!snapshot || snapshot.pageSize !== pageSize || typeof snapshot.html !== 'string') return null;
    const { threadOrder, loadedStart, loadedEnd, automatic, loadedNewer } = snapshot;
    if (!Array.isArray(threadOrder) || threadOrder.some(id => typeof id !== 'string' || !id)) return null;
    if (new Set(threadOrder).size !== threadOrder.length) return null;
    if (!Number.isInteger(loadedStart) || !Number.isInteger(loadedEnd)) return null;
    if (loadedStart < 0 || loadedStart > loadedEnd || loadedEnd > threadOrder.length) return null;
    if (typeof automatic !== 'boolean' || typeof loadedNewer !== 'boolean') return null;
    return snapshot;
  } catch {
    return null;
  }
};

export const discussionReadingUrl = (permalink, currentHref, preserveFragment) => {
  const url = new URL(permalink, currentHref);
  if (preserveFragment) url.hash = new URL(currentHref).hash;
  return url;
};
