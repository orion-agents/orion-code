// Sample js-c6 — resource lifecycle (clean reference)
// dispose clears the heartbeat timer, so no callback can fire after teardown.
class Worker {
  constructor(push) {
    this.push = push;
    this.timer = setInterval(() => this.beat(), 1000);
  }

  beat() {
    this.push({ type: 'heartbeat', at: Date.now() });
  }

  dispose() {
    clearInterval(this.timer);
  }
}

module.exports = { Worker };
