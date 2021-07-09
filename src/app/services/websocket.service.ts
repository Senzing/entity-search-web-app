import { Injectable } from '@angular/core';
import { BehaviorSubject, CompletionObserver, Observable, of, PartialObserver, Subject } from 'rxjs';
import { take, takeUntil, filter, map, tap, catchError, takeWhile } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
//import { v4 as uuidv4 } from 'uuid';
//import { AdminStreamConnProperties } from '@senzing/sdk-components-ng';
import { SzWebSocketConnectionParameters, SzWebSocketConnectionConfiguration, SzPocWebSocketService } from '@senzing/sdk-components-ng';

interface offlineMessage {
  data: any,
  onSent?: any
}

@Injectable({
  providedIn: 'root'
})
export class HufflePuffWebSocketService {
  public unsubscribe$ = new Subject<void>();
  /** when an error occurs it is sent to this subject */
  private _onErrorSubject = new Subject<any>();
  /** subscribe to this observable channel for error notification */
  public onError = this._onErrorSubject.asObservable();
  /** subject used to listen to connection status */
  private _onStatusChange: Subject<CloseEvent | Event> = new BehaviorSubject<CloseEvent | Event>(new CloseEvent('close'));
  /** observable published to when the state of connection changes. Raw Observable<CloseEvent | Event> from rxJS websocket stream */
  public onStatusChange: Observable<CloseEvent | Event> = this._onStatusChange.asObservable();
  /** when a the socket has been opened, reopened, or closed. returns true for connected, false for disconnected */
  public onConnectionStateChange: Observable<boolean> = this.onStatusChange.pipe(
    map( HufflePuffWebSocketService.statusChangeEvtToConnectionBool )
  )
  /** when the connected socket receives an upstream message */
  private _onMessageRecieved: Subject<any> = new Subject<any>();
  public onMessageRecieved = this._onMessageRecieved.asObservable();

  /** subject used for when messages sent by server */
  private message$: Subject<any> = new Subject<any>();
  /** observable published when server sends message */
  private messageRecieved: Observable<any> = this.message$.asObservable();

  /** messages sent while connection offline */
  private _offlineMessageQueue: offlineMessage[] = [];
  /** the amount of times to retry opening the socket connection if a disconnect happens */
  private _reconnectionAttemptsIncrement = 0;
  /** @internal */
  private _connected = false;
  /** 
   * returns true if the socket is currently open. false if disconnected 
   * @readonly
   **/
  public get connected(): boolean {
    return this._connected;
  }
  /** 
   * when a user manually(calls this.disconnect) this flag is set. this informs
   * the auto-reconnect mechanism NOT to attempt reconnect
   */
  private manuallyDisconnected = false;

  /** instance of AdminStreamConnProperties used for connection instantiation and behavior */
  public connectionProperties: SzWebSocketConnectionParameters = {
    "hostname": 'localhost:8555',
    "connected": false,
    "connectionTest": false,
    "reconnectOnClose": false,
    "reconnectConsecutiveAttemptLimit": 10,
    "path": "/"
  };

  static statusChangeEvtToConnectionBool(status: CloseEvent | Event) {
    let retVal = false;
    if(status){
      if((status as Event).type === 'open') {
        retVal = true;
      } else if((status as CloseEvent).type === 'close') {
        retVal = false;
      }
    }
    return retVal;
  }

  static getSocketUriFromConnectionObject(connProps: SzWebSocketConnectionParameters, path?: string, method?: "POST" | "PUT" | "GET"): string {
    return 
    let retVal = "ws://localhost:8955";
    if(connProps) {
      retVal  = (connProps.secure) ? "wss://" : "ws://";
      retVal += (connProps.hostname) ? connProps.hostname : 'localhost';
      retVal += (connProps.port) ? ':'+connProps.port : '';
      if(path) {
        retVal += ''+ path;
      } else if(connProps.path) {
        retVal += (connProps.path) ? ''+connProps.path : '';
      }
    }

    return retVal;
  }

  /** web socket subject used for connection */
  private ws$: WebSocketSubject<any>;

  /** send message to socket */
  public sendMessage(message: string): Observable<boolean> {
    let retSub = new Subject<boolean>();
    let retObs = retSub.asObservable();
    if((this.connectionProperties && !this._connected) || this.ws$ === undefined) {
      //console.log('queueing message..', this._offlineMessageQueue.length, this._connected, this.ws$.closed);
      this._offlineMessageQueue.push({data: message, onSent: () => {
        //console.log('[success] sent message.. ', message);
        retSub.next(true);
      }});
    } else if(this.ws$) {
      //console.log('sending message..', message, this._connected);
      this.ws$.pipe(
        take(1)
      ).subscribe((res) => {
        // does message match
        retSub.next(true); // for now just pub true
        //retSub.unsubscribe();
        //retSub.complete();
      });
      this.ws$.next(message);
    } else {
      console.warn('catastrophic premise. no ws$ object or not enough info to create one..');
    }
    return retObs;
  }

  public sendMessages(messages: any[] | string[]): Observable<boolean> {
    let retSub = new Subject<boolean>();
    let retObs = retSub.asObservable();
    if((this.connectionProperties && !this._connected) || this.ws$ === undefined) {
      //console.log('queueing message..', this._offlineMessageQueue.length, this._connected, this.ws$.closed);
      this._offlineMessageQueue = this._offlineMessageQueue.concat(
        (messages as any).map((message: any) => {
          return {data: JSON.stringify(message)}
        })
      );
    } else if(this.ws$) {
      //console.log('sending message..', message, this._connected);
      this.ws$.pipe(
        take(1)
      ).subscribe((res) => {
        // does message match
        retSub.next(true); // for now just pub true
        //retSub.unsubscribe();
        //retSub.complete();
      });
      messages.forEach((message: any | string) => {
        let msgStr = '';
        if((message as string).split) {
          // string
          msgStr = message;
        } else {
          // assume json object
          msgStr = JSON.stringify(message);
        }
        if(msgStr && !(msgStr.lastIndexOf('\n') >= (msgStr.length > 2 ? msgStr.length - 2 : msgStr.length))) {
          // add line ending
          msgStr  = msgStr +'\n';
        }
        // send message
        this.ws$.next( msgStr );
      });
      retSub.next(true);
    } else {
      console.warn('catastrophic premise. no ws$ object or not enough info to create one..');
    }
    return retObs;
  }

  constructor() {  
    /** track the connection status of the socket */
    this.onConnectionStateChange.subscribe((connected) => {
      if(!this._connected && connected) {
        // clear out any reconnect attempt increment
        console.warn(`cleared out reconnection increment number: was(${this._reconnectionAttemptsIncrement}) now(0)`);
        this._reconnectionAttemptsIncrement = 0;
      }
      this._connected = connected;
      console.warn('WebSocketService.onConnectionStateChange: ', this._connected);
    });
    
    /** when "reconnectOnClose" == true, reconnect socket */
    /*
    this.onStatusChange.pipe(
      map( WebSocketService.statusChangeEvtToConnectionBool ),
      filter( (_status) => { return this.connectionProperties.reconnectOnClose && this._reconnectionAttemptsIncrement <= this.connectionProperties.reconnectConsecutiveAttemptLimit && !_status; })
    ).subscribe( this._onDisconnectRetry.bind(this) );
    */
    this.onStatusChange.pipe(
      map( HufflePuffWebSocketService.statusChangeEvtToConnectionBool ),
      filter( (_status) => { 
        return this.connectionProperties.reconnectOnClose && !this.manuallyDisconnected && 
        this._reconnectionAttemptsIncrement < this.connectionProperties.reconnectConsecutiveAttemptLimit && 
        !_status;
      })
    ).subscribe( this._onDisconnectRetry.bind(this) );
    /** if messages were sent while connection offline send them on reconnection */
    this.onConnectionStateChange.pipe(
      filter( _status => _status === true)
    ).subscribe( this._onConnectProcessOfflineMessages.bind(this) );
  }
  /**
   * process any messages sent while socket not open
   * @internal
   */
  private _onConnectProcessOfflineMessages(){
    console.log('WebSocketService._onConnectProcessOfflineMessages: ', this._offlineMessageQueue);

    if(this._offlineMessageQueue && this._offlineMessageQueue.length > 0) {
      this._offlineMessageQueue = this._offlineMessageQueue.filter( (msg, _ind) => {
        this.ws$.pipe(
          take(1)
        ).subscribe((msg.onSent ? msg.onSent : () => {}));
        this.ws$.next(msg.data);
        return false;
      });
    }
  }
  /** open connection */
  public open(hostname?: string, port?: number, path?: string, method?: "POST" | "PUT" | "GET"): Observable<any> {
    // set up intial connection properties if not already set up
    this.connectionProperties = this.connectionProperties ? this.connectionProperties : {
      "hostname": hostname,
      "connected": false,
      "connectionTest": false,
      "reconnectOnClose": true,
      "reconnectConsecutiveAttemptLimit": 10,
      "path": (path ? path : "/"),
      "method": (method ? method : "GET")
    }
    // set connection properties if passed in
    this.connectionProperties.hostname  = hostname ? hostname : this.connectionProperties.hostname;
    this.connectionProperties.path      = path ? path : this.connectionProperties.path;
    this.connectionProperties.method    = method ? method : this.connectionProperties.method;
    if(port) { this.connectionProperties.port = port; } 

    // connection string
    let _wsaddr = HufflePuffWebSocketService.getSocketUriFromConnectionObject(this.connectionProperties);

    // when connection is opened proxy to status$
    const openSubject = new Subject<Event>();
    openSubject.pipe(
      tap( s => { 
        console.log('WebSocketService.open: ', s);
        this._connected = true;
      })
    ).subscribe(this._onStatusChange);
    // when connection is closed proxy to status$
    const closeSubject = new Subject<CloseEvent>();
    closeSubject.pipe(
      tap( s => {
        console.log('WebSocketService.close: ', s);
        this._connected = false;
      })
    ).subscribe(this._onStatusChange);
    const errorSubject = new Subject<CloseEvent>();
    errorSubject.pipe(
      tap( s => console.log('WebSocketService.error: ', s) ),
    ).subscribe(this._onErrorSubject);

    // when message is received proxy to status$
    const messageSubject = new Subject<Event>();
    messageSubject.pipe(
      tap( s => console.log('WebSocketService.message: ', s) ),
      map(_ => false)
    ).subscribe(this.message$);
    // initialize connection
    this.ws$ = webSocket({
      url: _wsaddr,
      deserializer: (value) => {
        if(value && value.data) {
          // this value is of type "MessageEvent" not "String"
          try{
            let rawVal: string = (value as MessageEvent).data;
            /*if(value && ((value as unknown) as string).trim) {
              rawVal = ((value as unknown) as string).trim();
            }*/
            var retVal = JSON.parse(rawVal);
            //console.log('parsed..', retVal.data);
            return retVal && retVal.data ? retVal.data : retVal;
          }catch(err) {
            //console.log('nooooooooooop', '"'+ value.data +'"', value.data, err);
            return value.data;
          }
        } else {
          //console.log('say wha? ', value);
          try{
            let rawVal: MessageEvent | string = value;
            if(value && ((value as unknown) as string).trim) {
              rawVal = ((value as unknown) as string).trim();
            }
            var retVal = JSON.parse(((rawVal as unknown) as string));
            //console.log('parsed..', value.data);
            return retVal;
          }catch(err) {
            //console.log('nooooooooooop', value, err);
            return value;
          }
        }
      },
      serializer: (value: any) => {
        return value && value.data ? value.data : value;
      },
      openObserver: openSubject,
      closeObserver: closeSubject
    });
    // do initial subscription otherwise conn will close
    this.ws$.pipe(
      takeUntil(this.unsubscribe$),
      catchError( (errors: any) => {
        if(errors && !errors.message) {
          errors.message = "Websocket could not connect to Stream interface. Double check that host is valid and reachable.";
        }
        this._onError(errors);
        return of(errors)
      } )
    ).subscribe((msg: any) => {
      //console.log('WebsocketService Message: ', msg);
      this._onMessageRecieved.next(msg);
    }, this._onError);

    // return observeable
    return this.ws$.asObservable();
  }

  private close() {
    console.warn('WebSocketService.close: ', this.ws$);
    
    if(this.ws$) {
      if(this.ws$.complete) this.ws$.complete();
      //if(this.ws$.unsubscribe) this.ws$.unsubscribe();
      //this.ws$ = undefined;
    }
  }
  public connect(): Observable<any> {
    this.manuallyDisconnected = false;
    return this.open();
  }
  public disconnect() {
    this.manuallyDisconnected = true;
    this.close();
  }
  /** reconnect to previously closed connection */
  public reconnect(path?: string, method?: "POST" | "PUT" | "GET"){
    if(this.ws$) {
      let onWSExists = () => {
        //console.log('WebSocketService.reconnect: ', this.connectionProperties, this.ws$);
        this.ws$.pipe(
          catchError( (error: Error) => {
            console.log('WebSocketService.reconnect: error: ', error, this.ws$.error.toString());
            if(error && !error.message) {
              error.message = `Could not connect to Stream interface(${HufflePuffWebSocketService.getSocketUriFromConnectionObject(this.connectionProperties)}) after a disconnect. Will continue to retry connection until reconnection attempt limit(${this._reconnectionAttemptsIncrement} / ${this.connectionProperties.reconnectConsecutiveAttemptLimit}) is reached.`;
            } else if(this.ws$ && this.ws$.hasError && this.ws$.error.toString) {
              error.message = this.ws$.error.toString();
            } else {
              error.message = 'Unknown error has occurred during reconnection attempt. Check Developer console for more info.'
            }
            this._onError(error);
            return of(error)
          } ),
          map( HufflePuffWebSocketService.statusChangeEvtToConnectionBool ),
          filter((status: boolean) => {
            return status;
          })
        ).subscribe((reconnected) => {
          //this.status$.next(true);
          this._reconnectionAttemptsIncrement = 0;
          console.log(`(${reconnected} | ${this._reconnectionAttemptsIncrement})!!successfully reconnected to "${HufflePuffWebSocketService.getSocketUriFromConnectionObject(this.connectionProperties)}"`, reconnected);
        })
      }

      if(this.connectionProperties && path && this.connectionProperties.path !== path){
        // kill con
        //console.log('calling ws$.complete');
        this.disconnect();
        // re-init with new path
        this.open(undefined, undefined, path, method).subscribe( onWSExists )
      } else {
        onWSExists();
      }
      
    } else if(this.connectionProperties && this.connectionProperties.connectionTest) {
      //console.log('WebSocketService.reconnect -> WebSocketService.open', this.ws$, this.connectionProperties);
      this.open(undefined, undefined, path, method);
    } else {
      // should we try to connect something that hasnt been flagged as valid?
      this._onErrorSubject.next('Websocket could not connect to Stream interface after a disconnect. Will continue to retry connection until reconnection attempt limit is reached.');
    }
  }
  /**
   * when autoreconnect set to true reconnect
   * @param connStatus 
   */
  private _onDisconnectRetry(connStatus){
    this._reconnectionAttemptsIncrement = this._reconnectionAttemptsIncrement +1;
    console.log(`(${this._reconnectionAttemptsIncrement} / ${this.connectionProperties.reconnectConsecutiveAttemptLimit}) WebSocketService._onDisconnectRetry: `, connStatus, this.connectionProperties, this);
    this.reconnect();
  }
  /** on error publish to _onErrorSubject */
  private _onError(err: any) {
    console.warn('WebSocketService._onError: ', err);
    this._onErrorSubject.next( err );
  }
  /** test connection properties */
  public testConnection(connectionProps: SzWebSocketConnectionParameters): Observable<boolean> {
    const retSub = new Subject<boolean>();
    const retVal: Observable<boolean> = retSub.asObservable();

    if(connectionProps) {
      let _wsaddr = HufflePuffWebSocketService.getSocketUriFromConnectionObject(this.connectionProperties, "/load-queue/bulk-data/records", "POST");

      const openSubject = new Subject<Event>();
      openSubject.pipe(
        tap( s => { 
          console.log('WebSocketService.open: ', s);
          this._connected = true;
          if(this.ws$ && this.close){
            this.close();
          } else {
            // no way to close, ensure response forwards
            retSub.next(this._connected);
            retSub.closed = true;
            retSub.unsubscribe();
            this._connected = false;
          }
        })
      ).subscribe(this._onStatusChange);
      
      const closeSubject = new Subject<CloseEvent>();
      closeSubject.pipe(
        tap( s => {
          console.log('WebSocketService.close: ', s);
          
          // conn opened then closed successfully
          retSub.next(this._connected);
          retSub.closed = true;
          retSub.unsubscribe();
          this._connected = false;

          if(this.ws$ && this.ws$.complete) {
            this.ws$.complete();
          }
        })
      ).subscribe(this._onStatusChange);

      this.ws$ = webSocket({
        url: _wsaddr,
        deserializer: (value: any) => {
          let data = value;
          try {
            data  = data.trim ? data.trim() : data;
            data  = JSON.parse(data);
          } catch(err) {}
          return data && data.data ? data.data : data;
        },
        serializer: (value: any) => {
          return value && value.data ? value.data : value;
        },
        openObserver: openSubject,
        closeObserver: closeSubject
      });
      this.ws$
      .pipe(
        take(1),
        catchError( (errors: any) => {
          console.warn('WS error: ', errors);
          this._onError(errors);
          return of(errors)
        } )
      ).subscribe( (res) => {
        this._connected = true;
      }, (err)=> {
        console.warn('WS error: ', err);
        this._connected = false;
        retSub.next(false);
        retSub.closed = true;
        retSub.unsubscribe();
        this.ws$.complete();
      })

    } else {
      this._connected = false;
      retSub.next(false);
      retSub.closed = true;
      retSub.unsubscribe();
    }

    return retVal;
  }
}