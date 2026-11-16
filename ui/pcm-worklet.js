// The microphone, as raw samples, for the huddle's live transcript: hands the
// page about 85 ms at a time (the page brings it to 16 kHz and uploads it).

class OmaPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.len++] = ch[i];
        if (this.len === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('oma-pcm', OmaPcm);
