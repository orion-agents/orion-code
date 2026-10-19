// Sample js-08 — resource lifecycle (defect)
// dispose() forgets the heartbeat timer: the callback keeps firing after the
// worker is torn down and touches disposed sockets.
class Worker {
  constructor(push) {
    this.push = push;
    this.disposed = false;
    this.timer = setInterval(() => this.beat(), 1000);
  }

  beat() {
    if (this.disposed) return;
    this.push({ type: 'heartbeat', at: Date.now() });
  }

  dispose() {
    this.disposed = true;
  }
}

module.exports = { Worker };
