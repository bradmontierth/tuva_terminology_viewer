let currentInstance = null;
let requestSequence = 0;

class MockSearchWorkerClient {
  constructor() {
    this.init = jest.fn(() => Promise.resolve());
    this.clearCache = jest.fn();
    this.terminate = jest.fn();
    this.requestHandlers = new Map();
    currentInstance = this;
  }

  search(query, options = {}) {
    const requestId = ++requestSequence;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.requestHandlers.set(requestId, {
      onUpdate: options.onUpdate,
      resolve: resolveFn,
      reject: rejectFn,
    });
    if (this.onSearch) {
      this.onSearch({ query, requestId });
    }
    return { requestId, promise };
  }

  emitPartial(requestId, payload) {
    const handler = this.requestHandlers.get(requestId);
    if (handler?.onUpdate) {
      handler.onUpdate({ ...payload, requestId, partial: true });
    }
  }

  resolve(requestId, payload) {
    const handler = this.requestHandlers.get(requestId);
    if (handler) {
      handler.resolve({ ...payload, requestId, partial: false });
      this.requestHandlers.delete(requestId);
    }
  }

  reject(requestId, error) {
    const handler = this.requestHandlers.get(requestId);
    if (handler) {
      handler.reject(error);
      this.requestHandlers.delete(requestId);
    }
  }

  static __getLatestInstance() {
    return currentInstance;
  }

  static __reset() {
    currentInstance = null;
    requestSequence = 0;
  }
}

export default MockSearchWorkerClient;
