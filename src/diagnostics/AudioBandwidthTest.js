// adapted from https://github.com/webrtc/testrtc/blob/master/src/js/bandwidth_test.js

import WebrtcCall from '../utils/WebrtcCall';
import Test from '../utils/Test';
import StatisticsAggregate from '../utils/StatisticsAggregate';
import ERROR_CODES from '../utils/testErrorCodes';

export default class AudioBandwidthTest extends Test {
  constructor () {
    super(...arguments);
    this.name = 'Audio Bandwidth Test';
    this.maxAudioBitrateKbps = 510;
    this.durationMs = 40000;
    this.statStepMs = 100;
    this.bweStats = new StatisticsAggregate(0.75 * this.maxAudioBitrateKbps * 1000);

    this.lastBytesSent = 0;
    this.lastTimestamp = null;
    this.bweStats2 = new StatisticsAggregate(0.75 * this.maxAudioBitrateKbps * 1000);

    this.rttStats = new StatisticsAggregate();
    this.packetsLost = null;
    this.startTime = null;
    this.call = null;
    // No Camera for audio only test
    this.constraints = {
      video: false
    };

    if (this.options.mediaOptions.audio.deviceId) {
      this.constraints.audio = {deviceId: this.options.mediaOptions.audio.deviceId};
    } else {
      this.constraints.audio = true;
    }

    this.log = [];
    this.stats = {};
  }

  start () {
    super.start();

    if (!this.options.iceConfig.iceServers.length) {
      const error = new Error('No ice servers were provided');
      error.pcCode = ERROR_CODES.ICE;
      error.details = this.log;
      return this.reject(error);
    }
    this.call = new WebrtcCall(this.options.iceConfig, this.logger);
    this.call.setIceCandidateFilter(WebrtcCall.isRelay);

    return this.doGetUserMedia(this.constraints)
      .then(stream => this.setupCall(stream))
      .then(this.runTest.bind(this))
      .then(this.completed.bind(this))
      .then(() => {
        if (this.hasError) {
          return Promise.reject(new Error('Audio Bandwidth Error'));
        }

        return this.resolve(this.getResults());
      })
      .catch(err => {
        err.pcCode = ERROR_CODES.MEDIA;
        const results = this.getResults();
        results.error = err;
        return this.reject(err);
      });
  }

  getResults () {
    return {
      log: this.log,
      stats: this.stats,
      constraints: this.constraints
    };
  }

  addLog (level, msg, details) {
    this.logger[level.toLowerCase()](msg, details);
    if (msg && typeof msg === 'object') {
      msg = JSON.stringify(msg);
    }
    if (level.toLowerCase() === 'error') {
      this.hasError = true;
    }
    // don't buffer debug logs
    if (level.toLowerCase() !== 'debug') {
      this.log.push(`${level}: ${msg}`);
    }
  }

  doGetUserMedia (constraints) {
    this.addLog('info', { status: 'pending', constraints });
    return navigator.mediaDevices.getUserMedia(constraints)
      .then((stream) => {
        const audioTrack = this.getDeviceName(stream.getAudioTracks());
        this.addLog('info', {status: 'success', audioTrack});
        return stream;
      })
      .catch(error => {
        error.pcCode = ERROR_CODES.MEDIA;
        this.addLog('error', {'status': 'fail', 'error': error});
        this.addLog('error', `Failed to get access to local media due to error: ${error.name}`);
        return this.reject(error);
      });
  }

  getDeviceName (tracks) {
    if (tracks.length === 0) {
      return null;
    }
    return tracks[0].label;
  }

  setupCall (stream) {
    stream.getTracks().forEach(t => this.call.pc1.pc.addTrack(t, stream));

    return this.call.establishConnection().then(() => {
      this.addLog('info', { status: 'success', message: 'establishing connection' });
      this.startTime = new Date();
      this.localTrack = stream.getAudioTracks()[0];
    }, (error) => {
      this.addLog('warn', { status: 'error', error });
      return Promise.reject(error);
    });
  }

  runTest () {
    return new Promise((resolve, reject) => {
      this.nextTimeout = setTimeout(() => {
        this.gatherStats().then(resolve, reject);
      }, this.statStepMs);
    });
  }

  gatherStats () {
    const now = new Date();
    if (now - this.startTime > this.durationMs) {
      return Promise.resolve();
    }

    return this.call.pc1.pc.getStats()
      .then(this.gotStats.bind(this))
      .catch((error) => this.addLog('error', 'Failed to getStats: ' + error));
  }

  gotStats (response) {
    if (!response) {
      this.addLog('error', 'Got no response from stats... odd...');
      return this.runTest();
    }
    const results = typeof response.result === 'function' ? response.result() : response;
    this.addLog('debug', 'Processing audio bandwidth stats', results);
    results.forEach((report) => {
      if (report.availableOutgoingBitrate) {
        const value = parseInt(report.availableOutgoingBitrate, 10);
        this.bweStats.add(new Date(report.timestamp), value);
      }
      if (report.currentRoundTripTime) {
        const value = parseFloat(report.currentRoundTripTime) * 1000;
        this.rttStats.add(new Date(report.timestamp), value);
      }
      if (report.roundTripTime) {
        const value = parseFloat(report.roundTripTime, 10);
        this.rttStats.add(new Date(report.timestamp), value);
      }
      if (report.bytesSent && report.ssrc) {
        const value = parseInt(report.bytesSent, 10);
        let interval = this.lastTimestamp ? report.timestamp - this.lastTimestamp : this.statStepMs;
        let intervalInSeconds = interval / 1000;
        const bytesSentThisInterval = value - this.lastBytesSent;
        const bwe = bytesSentThisInterval / intervalInSeconds;
        this.bweStats2.add(new Date(report.timestamp), bwe);
        this.lastBytesSent = value;
        this.lastTimestamp = report.timestamp;
      }
      if (report.packetsSent) {
        this.packetsSent = report.packetsSent;
      }
      if (report.packetsLost) {
        this.packetsLost = report.packetsLost;
      }
      if (report.frameWidth) {
        this.videoStats[0] = report.frameWidth;
      }
      if (report.frameHeight) {
        this.videoStats[1] = report.frameHeight;
      }
    });

    return this.runTest();
  }

  completed () {
    const stats = this.stats;

    stats.mbpsAvg = this.bweStats2.getAverage() / (1000);
    stats.mbpsMax = this.bweStats2.getMax() / (1000);

    this.addLog('info', `Send bandwidth estimate average: ${stats.mbpsAvg} mpbs`);
    this.addLog('info', `Send bandwidth estimate max: ${stats.mbpsMax} mbps`);

    stats.rttAverage = this.rttStats.getAverage();
    stats.rttMax = this.rttStats.getMax();
    stats.packetsSent = parseInt(this.packetsSent);

    if (this.packetsSent) {
      stats.packetLoss = parseInt(this.packetsLost || 0, 10) / parseFloat(this.packetsSent);
    }

    this.addLog('info', `RTT average: ${stats.rttAverage} ms`);
    this.addLog('info', `RTT max: ${stats.rttMax} ms`);
    this.addLog('info', `Packets sent: ${stats.packetsSent}`);
    this.addLog('info', `Packet loss %: ${stats.packetLoss}`);
    return this.results;
  }

  destroy () {
    super.destroy();
    window.clearTimeout(this.nextTimeout);
    if (this.call) {
      const pc = this.call.pc1;
      if (pc.getSenders) {
        pc.getSenders().forEach(sender => sender.track.stop());
      }
      if (pc.getTransceivers) {
        pc.getTransceivers().forEach(t => t.stop());
      }

      this.call.close();
      this.call = null;
    }
  }
}
