/**
 * Copyright (c) 2018, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
 *
 * WSO2 Inc. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

const { 
    DebugSession, InitializedEvent, StoppedEvent, OutputEvent, TerminatedEvent, 
    ContinuedEvent, LoggingDebugSession,
} = require('vscode-debugadapter');
const DebugManager = require('./DebugManager');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const openport = require('openport');

class BallerinaDebugSession extends LoggingDebugSession {
    initializeRequest(response, args) {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        this.packagePaths = {};
        this.dirPaths = {};
        this.threadIndexes = {};
        this.threads = [];
        this.debugArgs = {};
        this.debugManager = new DebugManager();

        this.debugManager.on('debug-hit', debugArgs => {
            const threadId = debugArgs.threadId || debugArgs.workerId;
            this.debugArgs[threadId] = debugArgs;
            this.currentThreadId = threadId;
            if (!this.threadIndexes[threadId]) {
                const index = this.threads.length + 1;
                this.threads.push({
                    threadId,
                    index, 
                    name: threadId.split('-')[0],
                });
                this.threadIndexes[threadId] = index;
            }
            this.sendEvent(new StoppedEvent('breakpoint', this.threadIndexes[threadId]));
        });

        this.debugManager.on('execution-ended', () => {
            this.sendEvent(new TerminatedEvent());
        });

        this.debugManager.on('session-error', e => {
            if (e) {
                this.sendEvent(new OutputEvent(e.message));
            }
        });

        this.sendResponse(response);
    }

    attachRequest(response, args) {
        this.debugManager.connect(`ws://${args.host}:${args.port}/debug`, () => {
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        });
    }

    launchRequest(response, args) {
        if (!args['ballerina.home']) {
            this.terminate("Couldn't start the debug server. Please set ballerina.home.");
            return;
        }

        const openFile = args.script;
        let cwd = path.dirname(openFile);
        let fileName = path.basename(openFile);
        
        const content = fs.readFileSync(openFile);
        const pkgMatch = content.toString().match('package\\s+([a-zA_Z_][\\.\\w]*);');
        if (pkgMatch && pkgMatch[1]) {
            const pkg = pkgMatch[1];
            const pkgParts = pkg.split('.');
            for(let i=0; i<pkgParts.length; i++) {
                cwd = path.dirname(cwd);
            }
            fileName = path.join(...pkgParts);
        }

        let executable = path.join(args['ballerina.home'], 'bin', 'ballerina');
        if (process.platform === 'win32') {
            executable += '.bat';
        }

        // find an open port 
        openport.find((err, port) => {
            if(err) { 
                this.terminate("Couldn't find an open port to start the debug server.");
                return;
            }

            let debugServer;
            debugServer = this.debugServer = spawn(
                executable,
                ['run', fileName, '--debug', port],
                { cwd }
            );
    
            debugServer.on('error', (err) => {
                this.terminate("Could not start the debug server.");
            });
            
            debugServer.stdout.on('data', (data) => {
                if (`${data}`.indexOf('Ballerina remote debugger is activated on port') > -1) {
                    this.debugManager.connect(`ws://127.0.0.1:${port}/debug`, () => {
                        this.sendResponse(response);
                        this.sendEvent(new InitializedEvent());
                    });
                }

                this.sendEvent(new OutputEvent(`${data}`));
            });

            debugServer.stderr.on('data', (data) => {
                if (`${data}`.indexOf('compilation contains errors') > -1) {
                    this.terminate('Failed to compile.');
                } else {
                    this.sendEvent(new OutputEvent(`${data}`));
                }
            });
        });
    }

    setBreakPointsRequest(response, args) {
        let fileName = args.source.path;
        let pkg = '.';

        const content = fs.readFileSync(args.source.path);
        const pkgMatch = content.toString().match('package\\s+([a-zA_Z_][\\.\\w]*);');
        if (pkgMatch && pkgMatch[1]) {
            pkg = pkgMatch[1];
            fileName = args.source.name;
            this.packagePaths[pkg] = path.dirname(args.source.path);
        }
        this.dirPaths[args.source.name] = path.dirname(args.source.path);
        
        this.debugManager.removeAllBreakpoints(fileName);
        const bps = [];
        args.breakpoints.forEach((bp, i) => {
            this.debugManager.addBreakPoint(bp.line, fileName, pkg);
            bps.push({id: i, line: bp.line, verified: true});
        });

        response.body = {
            breakpoints: bps,
        };
        this.sendResponse(response);
    }

    configurationDoneRequest(response) {
        this.debugManager.startDebug();
        this.sendResponse(response);
    }

    threadsRequest(response, args) {
        const a = args;
        const threads = this.threads.map(thread => (
            {id: thread.index, name: thread.name}
        ));
        response.body = { threads };
        this.sendResponse(response);
    }

    stackTraceRequest(response, args) { 
        const threadId = this.getThreadId(args);
        const { packagePath } = this.debugArgs[threadId].location;

        const stk = this.debugArgs[threadId].frames.map((frame, i) => {
            let root = this.dirPaths[frame.fileName];
            if (packagePath !== '.') {
                root = this.packagePaths[packagePath];
            }

            return {
                id: i,
                name: frame.frameName,
                line: frame.lineID,
                source: {
                    name: frame.fileName,
                    path: path.join(root, frame.fileName),
                }
            };
        });

        response.body = {
            stackFrames: stk,
            totalFrames: stk.length
        };
        this.sendResponse(response);
    }

    scopesRequest(response, args) {
        response.body = {
            scopes:[
                {
                    name: 'Local',
                    variablesReference: args.frameId + 1, // This can't be 0. As 0 indicates "don't fetch".
                    expensive: false,
                },
                {
                    name: 'Global',
                    variablesReference: args.frameId + 1001, // variableRefs larger than 1000 refer to globals
                    expensive: false,
                },
            ]
        };
        this.sendResponse(response);
    }

    variablesRequest(response, args) {
        let scope = "Local";
        let frameId = args.variablesReference - 1;
        if (frameId > 999) {
            scope = "Global";
            frameId = frameId - 1000;
        }
        const frame = this.debugArgs[this.currentThreadId].frames[frameId];
        const varsInScope = frame.variables.filter(v => v.scope === scope);
        response.body = {
            variables: varsInScope.map(variable => ({
                name: variable.name,
                type: "integer",
                value: variable.value,
                variablesReference: 0
            })),
        }
        this.sendResponse(response);
    }

    continueRequest(response, args) { 
        const threadId = this.getThreadId(args);
        this.sendEvent(new ContinuedEvent(threadId, false));
        this.debugManager.resume(threadId);
    }

    nextRequest(response, args) { 
        const threadId = this.getThreadId(args);
        this.debugManager.stepOver(threadId);
        this.sendResponse(response);
    }

    stepInRequest(response, args) { 
        const threadId = this.getThreadId(args);
        this.debugManager.stepIn(threadId);
        this.sendResponse(response);
    }

    stepOutRequest(response, args) {
        const threadId = this.getThreadId(args);
        this.debugManager.stepOut(threadId);
        this.sendResponse(response);
    }

    disconnectRequest(response) {
        if (this.debugServer) {
            this.debugManager.kill();
            this.debugServer.kill();
        }
        this.sendResponse(response);
    }

    terminate(msg) {
        this.sendEvent(new OutputEvent(msg));
        this.sendEvent(new TerminatedEvent());
    }

    getThreadId(args) {
        const threadIndex = args.threadId;
        return this.threads[threadIndex - 1].threadId;
    }
}

DebugSession.run(BallerinaDebugSession);
