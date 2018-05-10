/*
 * Copyright 2018-present Samsung Electronics Co., Ltd. and other contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import {
  LoggingDebugSession, DebugSession, Logger, logger, InitializedEvent, OutputEvent, Thread, Source,
  StoppedEvent, ContinuedEvent, StackFrame, TerminatedEvent, Breakpoint as AdapterBreakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as Fs from 'fs';
import * as Path from 'path';
import { IAttachRequestArguments } from './IotjsDebuggerInterfaces';
import { JerryDebuggerClient, JerryDebuggerOptions } from './JerryDebuggerClient';
import {
  JerryDebugProtocolDelegate, JerryDebugProtocolHandler, JerryMessageScriptParsed, JerryEvalResult,
  JerryMessageExceptionHit
} from './JerryProtocolHandler';
import { EVAL_RESULT_SUBTYPE } from './JerryProtocolConstants';

class IotjsDebugSession extends LoggingDebugSession {

  // We don't support multiple threads, so we can use a hardcoded ID for the default thread
  private static THREAD_ID = 1;

  private _args: IAttachRequestArguments;
  private _debugLog: boolean = false;
  private _debuggerClient: JerryDebuggerClient;
  private _protocolhandler: JerryDebugProtocolHandler;

  public constructor() {
    super('iotjs-debug.txt');

    // The debugger uses zero-based lines and columns.
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    logger.setup(Logger.LogLevel.Verbose, /*logToFile=*/false);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    // Runtime supports now threads so just return a default thread.
    response.body = {
      threads: [
        new Thread(IotjsDebugSession.THREAD_ID, 'thread 1')
      ]
    };
    this.sendResponse(response);
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the debug adapter about the features it provides.
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments
  ): void {
    this.log('initializeRequest');

    this.sendEvent(new InitializedEvent());

    // This debug adapter implements the configurationDoneRequest.
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsFunctionBreakpoints = false;
    response.body.supportsEvaluateForHovers = false;
    response.body.supportsStepBack = false;
    response.body.supportsRestartRequest = true;

    this.sendResponse(response);
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    this.log('configurationDoneRequest');

    super.configurationDoneRequest(response, args);
    this.sendResponse(response);
  }

  protected attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments): void {
    this.log('attachRequest');

    if (!args.address || args.address === '') {
      this.sendErrorResponse(response, 0, 'Must specify an address');
      return;
    }

    if (!args.port || args.port <= 0 || args.port > 35535) {
      this.sendErrorResponse(response, 0, 'Must specify a valid port');
      return;
    }

    if (!args.localRoot || args.localRoot === '') {
      this.sendErrorResponse(response, 0, 'Must specify a localRoot');
      return;
    }

    this._args = args;
    this._debugLog = args.debugLog || false;

    const onBreakpointHit = () => {
      this.log('onBreakpointHit');
      this.sendEvent(new StoppedEvent('breakpoint', IotjsDebugSession.THREAD_ID));
    };

    const onExceptionHit = (data: JerryMessageExceptionHit) => {
      this.log('onExceptionHit');
      this.sendEvent(new StoppedEvent('exception', IotjsDebugSession.THREAD_ID, data.message));
    };

    const onResume = () => {
      this.log('onResume');

      this.sendEvent(new ContinuedEvent(IotjsDebugSession.THREAD_ID));
    };

    const onScriptParsed = data => {
      this.log('onScriptParsed');
      this.handleSource(data);
    };

    const onClose = () => {
      this.log('onClose');
      this.sendEvent(new TerminatedEvent());
    };

    const protocolDelegate = <JerryDebugProtocolDelegate>{
      onBreakpointHit,
      onExceptionHit,
      onResume,
      onScriptParsed
    };

    this._protocolhandler = new JerryDebugProtocolHandler(protocolDelegate, message => this.log(message));
    this._debuggerClient = new JerryDebuggerClient(<JerryDebuggerOptions>{
      delegate: {
        onMessage: (message: Uint8Array) => this._protocolhandler.onMessage(message),
        onClose
      },
      host: args.address,
      port: args.port
    });
    this._protocolhandler.debuggerClient = this._debuggerClient;

    this._debuggerClient.connect()
      .then(() => this.log(`Connected to: ${args.address}:${args.port}`))
      .catch(error => this.log(error));

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments): void {
    this.log('launchRequest');

    this.sendErrorResponse(response, 0, 'Launching is not supported. Use Attach.');
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments
  ): void {
    this.log('disconnectRequest');

    this._debuggerClient.disconnect();

    this.sendEvent(new TerminatedEvent());
    this.sendResponse(response);
  }

  protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void {
    this.log('restartRequest: Not implemented yet');

    this.sendResponse(response);
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this.log('continueRequest');

    this._protocolhandler.resume()
      .then(() => {
        this.sendResponse(response);
      })
      .catch(error => this.sendErrorResponse(response, 0, error));
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this.log('nextRequest');

    this._protocolhandler.stepOver()
    .then(() => {
      this.sendResponse(response);
    })
    .catch(error => this.sendErrorResponse(response, 0, error));
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this.log('stepInRequest');

    this._protocolhandler.stepInto()
      .then(() => {
        this.sendResponse(response);
      })
      .catch(error => this.sendErrorResponse(response, 0, error));
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
    this.log('stepOutRequest');

    this._protocolhandler.stepOut()
    .then(() => {
      this.sendResponse(response);
    })
    .catch(error => this.sendErrorResponse(response, 0, error));
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
    this.log('pauseRequest');

    this._protocolhandler.pause()
    .then(() => {
      this.sendResponse(response);
    })
    .catch(error => this.sendErrorResponse(response, 0, error));
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    this.log('setBreakPointsRequest');

    const filename = args.source.name;
    const clientLines = args.lines || [];

    try {
      const scriptId = this._protocolhandler.getScriptIdByName(filename);
      const activeBp = this._protocolhandler.getActiveBreakpointsByScriptId(scriptId);
      const activeBpLines = activeBp.map(b => b.line);

      const newBp = clientLines.filter(b => activeBpLines.indexOf(b) === -1);
      const removeBp = activeBpLines.filter(b => clientLines.indexOf(b) === -1);
      const persistingBp = clientLines.filter(b => newBp.indexOf(b) === -1);

      let newBreakpoints: DebugProtocol.Breakpoint[] = [];
      await Promise.all(newBp.map(async b => {
        const breakpoint = this._protocolhandler.findBreakpoint(scriptId, b);
        return await this._protocolhandler.updateBreakpoint(breakpoint, true)
          .then(() => <DebugProtocol.Breakpoint> new AdapterBreakpoint(true, b));
      }))
      .then(breakpoints => {
        newBreakpoints = breakpoints;
      });

      removeBp.forEach(async b => {
        const breakpoint = this._protocolhandler.findBreakpoint(scriptId, b);
        await this._protocolhandler.updateBreakpoint(breakpoint, false);
      });

      const persistingBreakpoints = persistingBp.map(b => {
        return <DebugProtocol.Breakpoint> new AdapterBreakpoint(true, b);
      });

      response.body = {
        breakpoints: [...persistingBreakpoints, ...newBreakpoints]
      };

      this.sendResponse(response);
    } catch (error) {
      this.log(error.message);
    }
  }

  protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    this.log('evaluateRequest');

    this._protocolhandler.evaluate(args.expression)
      .then((result: JerryEvalResult) => {
        const value = result.subtype === EVAL_RESULT_SUBTYPE.JERRY_DEBUGGER_EVAL_OK ? result.value : 'Evaluate Error';

        response.body = {
          result: value,
          variablesReference: 0
        };

        this.sendResponse(response);
      })
      .catch(error => this.sendErrorResponse(response, 0, error));
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments
  ): void {
    this.log('stackTraceRequest');

    this._protocolhandler.requestBacktrace()
      .then(backtrace => {
        const stk = backtrace.map((f, i) => new StackFrame(
            i,
            f.func.name || 'global',
            this.pathToSource(`${this._args.localRoot}/${this.pathToBasename(f.func.sourceName)}`),
            f.line,
            f.func.column
          )
        );

        response.body = {
          stackFrames: stk,
          totalFrames: stk.length,
        };

        this.sendResponse(response);
      })
      .catch(error => this.sendErrorResponse(response, 0, error));
  }

  private handleSource(data: JerryMessageScriptParsed): void {
    const path = `${this._args.localRoot}/${this.pathToBasename(data.name)}`;
    const src = this._protocolhandler.getSource(data.id);

    const write = c => Fs.writeSync(Fs.openSync(path, 'w'), c);

    if (Fs.existsSync(path)) {
      const content = Fs.readFileSync(path, {
        encoding: 'utf8',
        flag: 'r'
      });

      if (content !== src) {
        write(src);
      }
    } else {
      write(src);
    }
  }

  private pathToSource(path): Source {
    return new Source(this.pathToBasename(path), path);
  }

  private pathToBasename(path: string): string {
    if (path === '' || path === undefined) path = 'debug_eval.js';
    return Path.basename(path);

  }

  private log(message: any): void {
    if (this._debugLog) {
      switch (typeof message) {
        case 'object':
          message = JSON.stringify(message, null, 2);
          break;
        default:
          message = message.toString();
          break;
      }

      this.sendEvent(new OutputEvent(`[DS] ${message}\n`, 'console'));
    }
  }
}

DebugSession.run(IotjsDebugSession);
