import { Injectable, Inject } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { ActivatedRouteSnapshot } from '@angular/router';
import { Observable, of, from, interval, Subject, BehaviorSubject, timer } from 'rxjs';
import { map, catchError, tap, switchMap, takeUntil, take, filter, takeWhile, delay } from 'rxjs/operators';
import { SzConfigurationService, SzAdminService, SzEntityTypesService, SzPrefsService, SzDataSourcesService } from '@senzing/sdk-components-ng';
import { HttpClient } from '@angular/common/http';
import { AuthConfig, SzWebAppConfigService } from './config.service';
import { 
    SzPocWebSocketService,
    SzWebSocketConnectionParameters, 
    AdminStreamAnalysisConfig, 
    AdminStreamLoadConfig 
} from '@senzing/sdk-components-ng';

import {
    determineLineEndingStyle,
    getFileTypeFromName,
    lineEndingStyle, 
    lineEndingStyleAsEnumKey,
    validImportFileTypes,
    getUtf8ByteLength
} from '../common/import-utilities';

//import { WebSocketService } from './websocket.service';
import { SzStreamingFileRecordParser } from '../common/streaming-file-record-parser';
import { BulkDataService, SzBulkDataAnalysis, SzBulkDataAnalysisResponse, SzBulkLoadResponse, SzBulkLoadResult, SzDataSourceRecordAnalysis, SzDataSourceBulkLoadResult, SzEntityTypeBulkLoadResult, SzEntityTypeRecordAnalysis } from '@senzing/rest-api-client-ng';

export interface AdminStreamSummaryBase {
    fileType?: any,
    fileName?: string,
    fileSize?: number,
    fileLineEndingStyle?: lineEndingStyle,
    fileColumns?: string[],
    characterEncoding: any,
    mediaType: any,
    recordCount: number,
    recordsWithRecordIdCount?: number,
    recordsWithDataSourceCount?: number,
    recordsWithEntityTypeCount?: number,
    missingDataSourceCount?: number,
    missingEntityTypeCount?: number,
    missingRecordIdCount?: number,
    bytesRead?: number,
    bytesSent?: number,
    bytesQueued?: number,
    dataSources?: string[],
    entityTypes?: string[],
    complete?: boolean
}

export interface AdminStreamLoadSummary extends AdminStreamSummaryBase {
    failedRecordCount: number,
    sentRecordCount: number,
    unsentRecordCount: number,
    loadedRecordCount: number,
    receivedRecordCount: number,
    incompleteRecordCount: number,
    status: string,
    resultsByDataSource: Array<SzDataSourceBulkLoadResult>;
    resultsByEntityType: Array<SzEntityTypeBulkLoadResult>;
    topErrors?: []
}

export interface AdminStreamAnalysisSummary extends AdminStreamSummaryBase {
    analysisByDataSource?: Array<SzDataSourceRecordAnalysis>;
    analysisByEntityType?: Array<SzEntityTypeRecordAnalysis>;
}

/*
export interface AdminStreamLoadByDataSourceResult {
    recordCount: number,
    loadedRecordCount: number,
    incompleteRecordCount: number,
    failedRecordCount: number,
    dataSource: string,
    topErrors: []
}
export interface AdminStreamLoadByEntityTypeResult {
    recordCount: number,
    loadedRecordCount: number,
    incompleteRecordCount: number,
    failedRecordCount: number,
    dataSource: string,
    topErrors: []
}
export interface AdminStreamLoadResponseData {
    recordCount: number,
    loadedRecordCount: number,
    incompleteRecordCount: number,
    failedRecordCount: number,
    characterEncoding: string,
    mediaType: string,
    missingDataSourceCount: number,
    missingEntityTypeCount: number,
    status: string,
    resultsByDataSource?: Array<SzDataSourceBulkLoadResult>,
    resultsByEntityType?: Array<SzEntityTypeBulkLoadResult>,
    topErrors: []
}*/

export interface StreamReaderComplete {
    (streamClosed: boolean): void;
}

/**
 * A service used to provide methods and services
 * used in the /admin interface
 */
@Injectable({
  providedIn: 'root'
})
export class AdminBulkDataService {
    /** subscription to notify subscribers to unbind */
    public unsubscribe$ = new Subject<void>();

    /** current file to analyze or load */
    public currentFile: File;
    /**  
     * current result of last analysis operation 
     * @deprecated
     **/
    public currentAnalysis: SzBulkDataAnalysis;

    /** current result of last file load attempt */
    public currentLoadResult: SzBulkLoadResult | AdminStreamLoadSummary;
    /** current result of last analysis operation */
    public currentAnalysisResult: SzBulkDataAnalysis | AdminStreamAnalysisSummary;

    /** map of current datasource name to new datasource names */
    public dataSourceMap: { [key: string]: string };
    /** map of current entity type name to new entity type names */
    public entityTypeMap: { [key: string]: string };
    /** current datasources */
    _dataSources: string[];
    /** current entity types */
    _entityTypes: string[];
    /** when the file input changes this subject is broadcast */
    public onCurrentFileChange = new Subject<File>();
    /** when the analysis result changes this behavior subject is broadcast */
    public onAnalysisChange             = new BehaviorSubject<SzBulkDataAnalysis>(undefined);
    /** when the analysis result is cleared */
    private _onAnalysisCleared          = new Subject<boolean>();
    public onAnalysisCleared            = this._onAnalysisCleared.asObservable();
    /** when the datasources change this behavior subject is broadcast */
    public onDataSourcesChange          = new BehaviorSubject<string[]>(undefined);
    /** when the entity types change this behavior subject is broadcast */
    public onEntityTypesChange          = new BehaviorSubject<string[]>(undefined);
    /** when a datasrc destination changes this subject is broadcast */
    public onDataSourceMapChange        = new Subject<{ [key: string]: string }>();
    /** when a enity type destination changes this subject is broadcast */
    public onEntityTypeMapChange        = new Subject<{ [key: string]: string }>();
    /** when the result of a load operation changes this behavior subject is broadcast */
    public onLoadResult                 = new BehaviorSubject<SzBulkLoadResult | AdminStreamLoadSummary>(undefined);
    /** when the result of a load operation has been cleared from memory */
    public _onImportJobCleared          = new Subject<boolean>();
    public onImportJobCleared           = this._onImportJobCleared.asObservable();

    private _onAutoCreatingDataSource   = false;
    private _streamLoadPaused           = false;
    private _streamAnalysisPaused       = false;
    private _onAutoCreatingDataSources  = new Subject<string[]>();
    public onAutoCreatingDataSources    = this._onAutoCreatingDataSources.asObservable();
    /** subjects used for aborting in-progress stream processing */
    public streamAnalysisAbort$: Subject<void>;
    public streamLoadAbort$: Subject<void>;

    // ------------------- stream loading -------------------
    private _onStreamAnalysisStarted            = new BehaviorSubject<AdminStreamAnalysisSummary>(undefined);
    private _onStreamAnalysisProgress           = new BehaviorSubject<AdminStreamAnalysisSummary>(undefined);
    private _onStreamAnalysisPaused             = new BehaviorSubject<boolean>(this._streamAnalysisPaused);
    private _onStreamAnalysisComplete           = new BehaviorSubject<AdminStreamAnalysisSummary>(undefined);
    private _onStreamAnalysisFileReadStarted    = new BehaviorSubject<AdminStreamAnalysisSummary>(undefined);
    private _onStreamAnalysisFileReadProgress   = new Subject<AdminStreamAnalysisSummary>();
    private _onStreamAnalysisFileReadComplete   = new BehaviorSubject<AdminStreamAnalysisSummary>(undefined);
    private _onStreamLoadStarted                = new BehaviorSubject<AdminStreamLoadSummary>(undefined);
    private _onStreamLoadProgress               = new BehaviorSubject<AdminStreamLoadSummary>(undefined);
    private _onStreamLoadPaused                 = new BehaviorSubject<boolean>(this._streamLoadPaused);
    private _onStreamLoadComplete               = new BehaviorSubject<AdminStreamLoadSummary>(undefined);
    private _onStreamLoadFileReadStarted        = new BehaviorSubject<AdminStreamLoadSummary>(undefined);
    private _onStreamLoadFileReadProgress       = new Subject<AdminStreamLoadSummary>();
    private _onStreamLoadFileReadComplete       = new BehaviorSubject<AdminStreamLoadSummary>(undefined);

    // --- public interfaces
    public onStreamAnalysisStarted              = this._onStreamAnalysisStarted.asObservable();
    public onStreamAnalysisProgress             = this._onStreamAnalysisProgress.asObservable();
    public onStreamAnalysisPaused               = this._onStreamAnalysisPaused.asObservable();
    public onStreamAnalysisComplete             = this._onStreamAnalysisComplete.asObservable();
    public onStreamAnalysisFileReadStarted      = this._onStreamAnalysisFileReadStarted.asObservable();
    public onStreamAnalysisFileReadProgress     = this._onStreamAnalysisFileReadProgress.asObservable();
    public onStreamAnalysisFileReadComplete     = this._onStreamAnalysisFileReadComplete.asObservable();
    public onStreamLoadStarted                  = this._onStreamLoadStarted.asObservable();
    public onStreamLoadProgress                 = this._onStreamLoadProgress.asObservable();
    public onStreamLoadPaused                   = this._onStreamLoadPaused.asObservable();
    public onStreamLoadComplete                 = this._onStreamLoadComplete.asObservable();
    public onStreamLoadFileReadStarted          = this._onStreamLoadFileReadStarted.asObservable();
    public onStreamLoadFileReadProgress         = this._onStreamLoadFileReadProgress.asObservable();
    public onStreamLoadFileReadComplete         = this._onStreamLoadFileReadComplete.asObservable();

    /** when the result of a load operation changes this behavior subject is broadcast */
    public onAnalysisResult = new BehaviorSubject<SzBulkDataAnalysis | AdminStreamAnalysisSummary>(undefined);
    /** when an error occurs this subject is emitted 
     * @internal
    */
    private _onError = new Subject<Error>();
    /** when an error occurs this subject is emitted */
    public onError = this._onError.asObservable();
    /** when the status of the websocket stream changes */
    private _onStreamStatusChange = new Subject<CloseEvent | Event>();
    public onStreamStatusChange = this._onStreamStatusChange.asObservable();
    public onStreamConnectionStateChange = this._onStreamStatusChange.asObservable().pipe(
        map( SzPocWebSocketService.statusChangeEvtToConnectionBool )
    )
    /** if a stream import is in progress, pause and data sending */
    public pauseStreamLoad() {
        this._onStreamLoadPaused.next(true);
    }
    /** if a stream import is in progress and been paused, but has not completed yet, resume data sending */
    public resumeStreamLoad() {
        this._onStreamLoadPaused.next(false);
    }
    /** when a file is being analyzed */
    public analyzingFile = new Subject<boolean>();
    /** when a file is being analyzed */
    public isAnalyzingFile = false;
    /** when a file is being analyzed in the current thread */
    public loadingFile = new Subject<boolean>();
    /** when a file is being loaded in to the engine on thread*/
    public isLoadingFile = false;
    public currentError: Error;
    /** use streaming file record importing */
    public set useStreamingForLoad(value: boolean) {
        this.prefs.admin.useStreamingForLoad = value;
    }
    public get useStreamingForLoad(): boolean {
        return this.prefs.admin.useStreamingForLoad;
    }
    /** use streaming file importing analysis */
    public set useStreamingForAnalysis(value: boolean) {
        this.prefs.admin.useStreamingForAnalysis = value;
    }
    public get useStreamingForAnalysis(): boolean {
        return this.prefs.admin.useStreamingForAnalysis;
    }
    
    /** convenience setter for setting both "useStreamingForLoad" and "useStreamingForAnalysis" to the same value */
    public set useStreaming(value: boolean) {
        this.useStreamingForAnalysis = value;
        this.useStreamingForLoad = value;
    }
    /** convenience getter, returns true if both useStreamingForAnalysis and useStreamingForLoad are set to true */
    public get useStreaming(): boolean {
        return (this.useStreamingForAnalysis && this.useStreamingForLoad);
    }
    /** when the load behavrior changes from stream to http or vise-versa */
    private _onUseStreamingSocketChange = new BehaviorSubject<boolean>(this.useStreamingForLoad);
    public onUseStreamingSocketChange = this._onUseStreamingSocketChange.asObservable();
    /** is the configuration for streaming valid */
    public get canOpenStreamSocket(): boolean {
        return (this.webSocketService && this.webSocketService.connectionProperties) ? this.webSocketService.connectionProperties.connectionTest : false;
    }
    /** parameters that change behavior of streaming mode analysis. eg "sampleSize", "ignoreRecordsWithNoDataSource" */
    public get streamAnalysisConfig(): AdminStreamAnalysisConfig {
        return this.prefs.admin.streamAnalysisConfig;
    }
    /** parameters that change behavior of streaming mode analysis. eg "sampleSize", "ignoreRecordsWithNoDataSource" */
    public set streamAnalysisConfig(value: AdminStreamAnalysisConfig) {
        this.prefs.admin.streamAnalysisConfig = value;
    }
    /** proxy to websocket service connection properties */
    public set streamConnectionProperties(value: SzWebSocketConnectionParameters) {
        //this.webSocketService.connectionProperties = value;
        // update stream connection prefs
        this.prefs.admin.streamConnectionProperties = value;
    }
    public get streamConnectionProperties(): SzWebSocketConnectionParameters {
        return this.webSocketService.connectionProperties;
    }
    /** parameters that change behavior of loading/importing records via streaming interface. eg "mapUnspecifieD", "ignoreRecordsWithNoDataSource" */
    public get streamLoadConfig(): AdminStreamLoadConfig {
        return this.prefs.admin.streamLoadConfig;
    }
    public set streamLoadConfig(value: AdminStreamLoadConfig) {
        this.prefs.admin.streamLoadConfig = value
    }
    public set streamBulkPrefSet(value: boolean) {
        if(!value && this.prefs.admin.bulkSet) {
            // if changing from false to true, do immediate prefschange event
            this.prefs.admin.prefsChanged.next( this.prefs.admin.toJSONObject() );
        }
        this.prefs.admin.bulkSet = value;
    }
    public get streamConnected(): boolean {
        return this.webSocketService.connected;
    }
    // /AdminStreamAnalysisConfig, AdminStreamLoadConfig


    /** the file to analyze, map, or load */
    public set file(value: File) {
        this.currentFile = value;
        this.currentAnalysis = null;
        this.currentAnalysisResult = null;
        this.currentLoadResult = null;
        this.onCurrentFileChange.next( this.currentFile );
    }
    /** the file being analyzed, mapped, or loaded */
    public get file(): File {
        return this.currentFile;
    }
    /** the datasources currently present */
    private get dataSources(): string[] {
        return this._dataSources;
    }
    /** the entity types currently present */
    private get entityTypes(): string[] {
        return this._entityTypes;
    }

    constructor(
        public prefs: SzPrefsService,
        private adminService: SzAdminService,
        //private bulkDataService: SzBulkDataService,
        private bulkDataService: BulkDataService,
        private datasourcesService: SzDataSourcesService,
        private entityTypesService: SzEntityTypesService,
        private webSocketService: SzPocWebSocketService,
    ) {
        this.prefs.admin.prefsChanged.subscribe((prefs) => {
            //console.log('AdminBulkDataService.prefs.admin.prefChanged: ', this.webSocketService.connected, prefs);
            if(prefs && prefs && prefs.streamConnectionProperties !== undefined) {
                let _streamConnProperties = (prefs.streamConnectionProperties) as SzWebSocketConnectionParameters;
                //console.log('stream connection properties saved to prefs: ', JSON.stringify(_streamConnProperties) == JSON.stringify(this.streamConnectionProperties), _streamConnProperties, this.streamConnectionProperties);
                this.webSocketService.connectionProperties = _streamConnProperties;
                // I tried doing some fancy checking etc
                // more reliable to just always publish this on change
                this._onUseStreamingSocketChange.next( (_streamConnProperties.connectionTest && prefs.useStreamingForLoad && prefs.useStreamingForAnalysis) );
            } else {
                console.warn('no stream connection props in payload: ', prefs);
            }
        });
        this.webSocketService.onError.subscribe((error: Error) => {
            //console.warn('AdminBulkDataService.webSocketService.onError: ', error);
            this._onError.next(error);
        });
        this.webSocketService.onStatusChange.subscribe((statusEvent: CloseEvent | Event) => {
            console.warn('AdminBulkDataService.webSocketService.onStatusChange: ', statusEvent);
            this._onStreamStatusChange.next(statusEvent);
        });
        /*
        this.webSocketService.onMessageRecieved.subscribe((data: any) => {
            console.log('AdminBulkDataService.webSocketService.onMessageRecieved: ', data);
        });*/
        /** check if "reconnection error" is present, if connection state changes to "true" clear out error */
        this.webSocketService.onConnectionStateChange.pipe(
            takeUntil(this.unsubscribe$),
            filter( (connected) => {
                return (this.currentError !== undefined) && connected && !this.streamConnectionProperties.connected;
            }),
          ).subscribe((status) => {
            console.warn('AdminBulkDataService.webSocketService.onConnectionStateChange: clear current error:', this.currentError);
            // check to see if we should clear the current error
            this.currentError = undefined;
          });
        this.onCurrentFileChange.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe( (file: File) => {
            if(!file){ return; }
            
            //console.info('AdminBulkDataService().onCurrentFileChange: ', file, this.streamAnalysisConfig, this.streamConnectionProperties);

            if(this.useStreamingForLoad && this.canOpenStreamSocket) {
                // open analysis stream
                this.streamAnalyze(file).pipe(
                    takeUntil(this.unsubscribe$),
                    take(1)
                )
                .subscribe((result: AdminStreamAnalysisSummary) => {
                    //this.currentAnalysisResult = result;
                    console.log('AdminBulkDataService().onCurrentFileChange.streamAnalyze: result', result);
                }, (error: Error) =>{
                    console.warn('AdminBulkDataService().onCurrentFileChange.streamAnalyze: error', error)
                })
            } else {
                this.analyzingFile.next(true);
                // standard serialized payload
                this.analyze(file).toPromise().then( (analysisResp: SzBulkDataAnalysisResponse) => {
                    //console.log('autowire analysis resp on file change: ', analysisResp, this.currentAnalysis);
                    this.analyzingFile.next(false);
                }, (err) => {
                    console.warn('analyzing of file threw..', err);
                });
            }
        });
        this.analyzingFile.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe( (isAnalyzing: boolean) => {
            this.isAnalyzingFile = isAnalyzing;
        });
        this.loadingFile.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe( (isLoading: boolean) => {
            this.isLoadingFile = isLoading;
        });
        // update datasources in case new ones were added on load
        this.onLoadResult.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe( (resp: SzBulkLoadResult) => {
            this.updateDataSources();
        });
        // update entity types in case new ones were added on load
        this.onLoadResult.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe( (resp: SzBulkLoadResult) => {
            this.updateEntityTypes();
        });
        this.onError.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe( (err: Error) => {
            console.log('error happened: ', err);
            this.currentError = err;
        });
        this.onAutoCreatingDataSources.subscribe( (dataSources: string[] | undefined) => {
            this._onAutoCreatingDataSource = (dataSources && dataSources.length > 0) ? true : false;
        });
        this.onStreamLoadPaused.subscribe( (isPaused: boolean) => {
            this._streamLoadPaused = isPaused;
        });
        this.onStreamAnalysisPaused.subscribe( (isPaused: boolean) => {
            this._streamAnalysisPaused = isPaused;
        });
        this.adminService.onServerInfo.pipe(
            takeUntil( this.unsubscribe$ )
        ).subscribe((info) => {
            //console.log('ServerInfo obtained: ', info);
        });
        this.updateDataSources();
        this.updateEntityTypes();
    }

    /** update the internal list of datasources
     * @internal
     */
    private updateDataSources() {
        this.datasourcesService.listDataSources().pipe(
        takeUntil( this.unsubscribe$ )
        ).subscribe((datasources: string[]) => {
        //console.log('datasources obtained: ', datasources);
        this._dataSources = datasources.filter(s => s !== 'TEST' && s !== 'SEARCH');
        this.onDataSourcesChange.next(this._dataSources);
        },
        (err) => {
        // ignore errors since this is a auto-req
        });
    }
    /** update the internal list of datasources
     * @internal
     */
    private updateEntityTypes() {
        this.entityTypesService.listEntityTypes().pipe(
        takeUntil( this.unsubscribe$ )
        ).subscribe((entityTypes: string[]) => {
        //console.log('entity types obtained: ', entityTypes);
        this._entityTypes = entityTypes.filter(s => s !== 'TEST' && s !== 'SEARCH');
        this.onEntityTypesChange.next(this._entityTypes);
        },
        (err) => {
        // ignore errors since this is a auto-req
        });
    }
    /** create a new datasource */
    public createDataSources(dataSources: string[]): Observable<string[]> {
        console.log('SzBulkDataService.createDataSources: ', dataSources);
        return this.datasourcesService.addDataSources(dataSources);
    }
    /** create a new entity type */
    public createEntityTypes(entityTypes: string[]): Observable<string[]> {
        console.log('SzBulkDataService.createEntityTypes: ', entityTypes);
        return this.entityTypesService.addEntityTypes(entityTypes, "ACTOR");
    }

    /** analze a file and prep for mapping */
    public analyze(file: File): Observable<SzBulkDataAnalysisResponse> {
        //console.log('SzBulkDataService.analyze: ', file);
        this.currentError = undefined;
        this.analyzingFile.next(true);
        return this.bulkDataService.analyzeBulkRecords(file).pipe(
        catchError(err => {
            this._onError.next(err);
            return of(undefined);
        }),
        tap( (result: SzBulkDataAnalysisResponse) => {
            this.analyzingFile.next(false);
            this.currentAnalysis = (result && result.data) ? result.data : {};
            this.dataSourceMap = this.getDataSourceMapFromAnalysis( this.currentAnalysis.analysisByDataSource );
            this.entityTypeMap = this.getEntityTypeMapFromAnalysis( this.currentAnalysis.analysisByEntityType );
            this.onDataSourceMapChange.next( this.dataSourceMap );
            this.onEntityTypeMapChange.next( this.entityTypeMap );
            this.onAnalysisChange.next( this.currentAnalysis );
            console.log('analyze set analysis respose: ', this.dataSourceMap, this.entityTypeMap, this.currentAnalysis);
        })
        )
    }
    /**
     * load a files contents in to a datasource.
     * @TODO show usage example.
     */
    public load(file?: File, dataSourceMap?: { [key: string]: string }, entityTypeMap?: { [key: string]: string }, analysis?: SzBulkDataAnalysis ): Observable<SzBulkLoadResult> | undefined {
        //console.log('SzBulkDataService.load: ', dataSourceMap, entityTypeMap, file, this.currentFile);
        file = file ? file : this.currentFile;
        this.currentError = undefined;
        dataSourceMap = dataSourceMap ? dataSourceMap : this.dataSourceMap;
        entityTypeMap = entityTypeMap ? entityTypeMap : this.entityTypeMap;
        analysis      = analysis ?      analysis      : this.currentAnalysis;

        if(file && dataSourceMap && analysis) {
        const newDataSources = this.currentAnalysis.analysisByDataSource.filter(a => {
            const targetDS = this.dataSourceMap[((a.dataSource === null || a.dataSource === undefined) ? "" : a.dataSource)];
            return (targetDS && this._dataSources.indexOf(targetDS) < 0);
        }).map( (b) => {
            return this.dataSourceMap[(b.dataSource === null || b.dataSource === undefined ? "" :  b.dataSource)];
        });
        const newEntityTypes = this.currentAnalysis.analysisByEntityType.filter(a => {
            const targetET = this.entityTypeMap[((a.entityType === null || a.entityType === undefined) ? "" : a.entityType )];
            return (targetET && this._entityTypes.indexOf(targetET) < 0);
        }).map( (b) => {
            return this.entityTypeMap[(b.entityType === null || b.entityType === undefined ? "" : b.entityType)];
        });

        let promise = Promise.resolve([]);
        const promises = [];
        const retVal: Subject<SzBulkLoadResult> =  new Subject<SzBulkLoadResult>();
        // create new datasources if needed
        if (newDataSources.length > 0) {
            //console.log('create new datasources: ', newDataSources);
            const pTemp = this.createDataSources(newDataSources).toPromise();
            promises.push( pTemp );
        }
        // create new entity types if needed
        if (newEntityTypes.length > 0) {
            //console.log('create new entity types: ', newEntityTypes);
            const pTemp = this.createEntityTypes(newEntityTypes).toPromise();
            promises.push( pTemp );
        }
        promise = Promise.all( promises );

        // no new datasources or already avail
        this.loadingFile.next(true);
        promise.then(() => {
            //this.bulkDataService.loadBulkRecords(file, dataSource?: string, mapDataSources?: string, mapDataSource?: Array<string>, entityType?: string, mapEntityTypes?: string, mapEntityType?: Array<string>, progressPeriod?: string, observe?: 'body', reportProgress?: boolean)
            //this.bulkDataService.loadBulkRecords(file, dataSource, mapDataSources, mapDataSource, entityType?: string, mapEntityTypes, mapEntityType, progressPeriod, observe, reportProgress)
            this.bulkDataService.loadBulkRecords  (file, undefined,  JSON.stringify(dataSourceMap),  undefined,     undefined,           JSON.stringify(entityTypeMap)).pipe(
            //this.bulkDataService.loadBulkRecords(file, dataSourceMap, entityTypeMap ).pipe(
            catchError((err: Error) => {
                console.warn('Handling error locally and rethrowing it...', err);
                this.loadingFile.next(false);
                this._onError.next( err );
                return of(undefined);
            }),
            tap((response: SzBulkLoadResponse) => {
                //console.log('RESPONSE', dataSourceMap, response.data);
                this.currentLoadResult = response.data;
                this.onLoadResult.next( this.currentLoadResult );
                this.loadingFile.next(false);
                //retVal.next(response.data);
            }),
            map((response: SzBulkLoadResponse) => {
                return response.data;
            })
            ).pipe(
            takeUntil( this.unsubscribe$ )
            ).subscribe( (data: SzBulkDataAnalysis) => {
            console.log('SzBulkDataService.load', this.currentLoadResult, data);
            retVal.next(data);
            });
        });
        return retVal.asObservable();
        } else {
        console.warn('missing required parameter: ', file, dataSourceMap);
        throw new Error('missing required parameter: '+ file.name);
        return;
        }
    }
    /**
     * Used to keep a internal map of source to target datasource names.
     * @internal
     */
    public getDataSourceMapFromAnalysis(analysisArray: SzDataSourceRecordAnalysis[]): { [key: string]: string } {
        const _dsMap: { [key: string]: string } = {};
        if(analysisArray && analysisArray.forEach) {
            analysisArray.forEach(a => {
                if (this._dataSources.indexOf(a.dataSource) >= 0) {
                _dsMap[a.dataSource] = a.dataSource;
                } else if(a.dataSource !== null) {
                // this will automatically get mapped to specified datasource
                _dsMap[a.dataSource] = a.dataSource;
                }
            });
        }

        return _dsMap;
    }
    /**
     * Used to keep a internal map of source type to target entity type names.
     * @internal
     */
    public getEntityTypeMapFromAnalysis(analysisArray: SzEntityTypeRecordAnalysis[]): { [key: string]: string } {
        const _etMap: { [key: string]: string } = {};

        if(analysisArray && analysisArray.forEach) {
        analysisArray.forEach(a => {
            if (this._entityTypes.indexOf(a.entityType) >= 0) {
            _etMap[a.entityType] = a.entityType;
            } else if(a.entityType !== null) {
            _etMap[a.entityType] = a.entityType;
            } else if(a.entityType === null) {
            _etMap[""] = 'GENERIC';
            //_etMap[a.entityType] = 'GENERIC';
            }
        });
        }
        return _etMap;
    }
    /**
     * change the destination datasource of a file currently being mapped to datasource.
     */
    public changeDataSourceName(fromDataSource: string, toDataSource: string) {
        fromDataSource = (fromDataSource === null || fromDataSource === undefined) ? "" : fromDataSource;
        this.dataSourceMap = this.dataSourceMap;
        this.dataSourceMap[fromDataSource] = toDataSource;
        //console.log('DS MAP ' + fromDataSource + ' TO ' + toDataSource, this.dataSourceMap);
    }
    /**
     * change the destination entity type of a file currently being mapped to a entity type.
     */
    public changeEntityTypeName(fromEntityType: string, toEntityType: string) {
        fromEntityType = (fromEntityType === null || fromEntityType === undefined) ? "" : fromEntityType;
        //console.log('ET MAP ' + fromEntityType + ' TO ' + toEntityType, this.entityTypeMap);
        this.entityTypeMap = this.entityTypeMap;
        this.entityTypeMap[fromEntityType] = toEntityType;
    }
    /** subscription to notify subscribers to unbind */
    public abort(): void {
        if(this.streamAnalysisAbort$) {
            this.streamAnalysisAbort$.next();
            this.streamAnalysisAbort$.complete();
            this.streamAnalysisAbort$ = undefined;
            delete this.streamAnalysisAbort$;
        }
        if(this.streamLoadAbort$) {
            this.streamLoadAbort$.next();
            this.streamLoadAbort$.complete();
            this.streamLoadAbort$ = undefined;
            delete this.streamLoadAbort$;
        }
        console.log('AdminBulkDataService.abort()', this.streamAnalysisAbort$, this.streamLoadAbort$);
    }
    /** clear any file and associated data. removes file focus context */
    public clear(): void {
        this.currentAnalysis        = undefined;
        this.currentLoadResult      = undefined;
        this.currentAnalysisResult  = undefined;
        this.currentFile            = undefined;
        this.dataSourceMap          = undefined;
        this.entityTypeMap          = undefined;
        this.onAnalysisChange.next( this.currentAnalysis );
        this.onLoadResult.next( this.currentLoadResult );
        this.onCurrentFileChange.next( this.currentFile );

        /** clear out behavior subject states */
        //this._onStreamAnalysisComplete.next(undefined);
        //this._onStreamAnalysisStarted.next(undefined);
        //this._onStreamLoadStarted.next(undefined);
        //this._onStreamLoadComplete.next(undefined);
        this._onStreamAnalysisStarted.next(undefined);
        this._onStreamAnalysisProgress.next(undefined);
        this._onStreamAnalysisComplete.next(undefined);
        this._onStreamAnalysisFileReadStarted.next(undefined);
        this._onStreamAnalysisFileReadComplete.next(undefined);
        this._onStreamLoadStarted.next(undefined);
        this._onStreamLoadProgress.next(undefined);
        this._onStreamLoadComplete.next(undefined);
        this._onStreamLoadFileReadStarted.next(undefined);
        this._onStreamLoadFileReadComplete.next(undefined);

        /** emit cleared event */
        this._onAnalysisCleared.next(true);
        this._onImportJobCleared.next(true);
    }
    /**
     * unsubscribe event streams
     */
    destroy() {
        this.unsubscribe$.next();
        this.unsubscribe$.complete();
    }

    // -------------------------------------- streaming handling --------------------------------------

    /** if the websocket stream has been interupted or severed reconnect it */
    public reconnectStream() {
        if(!this.webSocketService.connected) {
            // do additional check to see if it's attempting to establish connection but has 
            // not successfully done so yet
            this.webSocketService.reconnect();
        } else {
            // were already connected, ignore
        }
    }
    /** if the websocket stream is currently connected disconnect it */
    public disconnectStream() {
        if(this.webSocketService.connected) {
            this.webSocketService.disconnect();
        } else {
            // were already disconnected, ignore
        }
    }
    /** alias to webSocketService.sendMessage */
    public sendWebSocketMessage(message: string): Observable<boolean> {
        return this.webSocketService.sendMessage(message);
    }
    
    /** takes a JSON file and analyze it */
    public streamAnalyze(file: File): Observable<AdminStreamAnalysisSummary> {
        //console.log('SzBulkDataService.streamAnalyze: ', file);
        // event streams
        let retSubject  = new Subject<AdminStreamAnalysisSummary>();
        let retObs      = retSubject.asObservable();
        // set up subject used for aborting in progress subscriptions
        if(!this.streamAnalysisAbort$ || this.streamAnalysisAbort$ === undefined || (this.streamAnalysisAbort$ && this.streamAnalysisAbort$.closed)){
            this.streamAnalysisAbort$ = new Subject();
        }

        // file related
        file = file ? file : this.currentFile;
        let fileSize = file && file.size ? file.size : 0;
        let fileType = getFileTypeFromName(file);
        let fileName = (file && file.name) ? file.name : undefined;
        // record queues
        let readRecords                 = [];
        let readStreamComplete          = false;
        // socket related
        /*
        let streamAnalysisEndpoint      = "/bulk-data/analyze";
        if(!this.webSocketService.connected){
            // we need to reopen connection
            console.log('SzBulkDataService.streamAnalyze: websocket needs to be opened: ', this.webSocketService.connected, this.streamConnectionProperties);
            this.webSocketService.reconnect(streamAnalysisEndpoint, "POST");
        } else {
            console.log('SzBulkDataService.streamAnalyze: websocket thinks its still connected: ', this.webSocketService.connected, this.streamConnectionProperties);
        }*/

        // construct summary object that we can report 
        // statistics to
        let summary: AdminStreamAnalysisSummary = {
            fileType: fileType,
            mediaType: fileType,
            fileName: fileName,
            fileSize: fileSize,
            fileLineEndingStyle: lineEndingStyle.unknown,
            characterEncoding: 'utf-8',
            recordCount: 0,
            recordsWithRecordIdCount: 0,
            recordsWithDataSourceCount: 0,
            recordsWithEntityTypeCount: 0,
            missingDataSourceCount: 0,
            missingEntityTypeCount: 0,
            missingRecordIdCount: 0,
            bytesRead: 0,
            bytesSent: 0,
            bytesQueued: 0,
            fileColumns: [],
            dataSources: [],
            entityTypes: [],
            complete: false
        }
        // initialize behavior subjects with base info
        this._onStreamAnalysisStarted.next(summary); // singleton
        this._onStreamAnalysisFileReadStarted.next(summary); // singleton
        retSubject.next(summary); // local

        // read file contents as stream
        // parse to array of records
        this.parseRecordsFromFile(file, (streamStatus) => {
            // on stream complete, do thing
            //console.warn('SzBulkDataService.streamAnalyze: file stream read complete.');
            readStreamComplete = true;
            this._onStreamAnalysisProgress.next(summary);
            retSubject.next(summary); // local
            this._onStreamAnalysisFileReadComplete.next(summary);
        }).pipe(
            takeUntil(this.streamAnalysisAbort$)
        ).subscribe(
            (records) => {
                this.updateStatsFromRecords(summary, records);
                // do count inc before we add to summary otherwise well double
                summary.recordCount         = summary.recordCount + records.length;
                // now concat
                readRecords                 = readRecords.concat(records);
                //console.log(`SzBulkDataService.streamAnalyze: read ${summary.recordCount} records`);
                this._onStreamAnalysisProgress.next(summary);
                this._onStreamAnalysisFileReadProgress.next(summary);
                retSubject.next(summary); // local
            }
        );
        
        // when ANYTHING changes, update the singleton "currentAnalysisResult" var so components can read status
        retObs.subscribe((summary: AdminStreamAnalysisSummary) => {
            this.currentAnalysisResult = summary;
        });

        // ---------------------------- on complete evt handlers ----------------------------
        // proxy "onStreamAnalysisReadComplete" to "onStreamAnalysisComplete"
        // since this is the only phase of this function
        this._onStreamAnalysisFileReadComplete.pipe(
            takeUntil(this.streamAnalysisAbort$),
            filter((summary: AdminStreamAnalysisSummary) => { return summary !== undefined;}),
            take(1),
            delay(2000)
        ).subscribe((summary: AdminStreamAnalysisSummary) => {
            summary.complete = true;
            this._onStreamAnalysisComplete.next(summary);
        });

        // on end of records queue double-check if whole thing is complete
        this.onStreamAnalysisComplete.pipe(
            takeUntil(this.streamAnalysisAbort$),
            filter((summary: AdminStreamAnalysisSummary) => { return summary !== undefined;}),
            take(1),
            tap( (summary: AdminStreamAnalysisSummary) => {
                this.analyzingFile.next(false);
                this.dataSourceMap = this.getDataSourceMapFromAnalysis( summary.analysisByDataSource );
                this.entityTypeMap = this.getEntityTypeMapFromAnalysis( summary.analysisByEntityType );
                this.onDataSourceMapChange.next( this.dataSourceMap );
                this.onEntityTypeMapChange.next( this.entityTypeMap );
                //this.onAnalysisChange.next( this.currentAnalysisResult );
            })
        ).subscribe((summary: AdminStreamAnalysisSummary) => {
            if(readStreamComplete && summary) {
                // set this to true to end batching loop Observeable
                //console.warn('stream load complete 2', summary);
                summary.complete = true;
            } else {
                //console.warn('stream analysis complete 2', readStreamComplete, summary);
            }
        });
        return retObs;
    }
   /** perform streaming import of records over websocket interface 
     * takes a file as argument, stream reads file, parses records,
     * then batch chunks to websocket connection. 
     * @returns Observeable<AdminStreamLoadSummary>
    */
    streamLoad(file?: File, dataSourceMap?: { [key: string]: string }, entityTypeMap?: { [key: string]: string }, analysis?: SzBulkDataAnalysis): Observable<AdminStreamLoadSummary> {
        // parameter related
        dataSourceMap = dataSourceMap ? dataSourceMap : this.dataSourceMap;
        entityTypeMap = entityTypeMap ? entityTypeMap : this.entityTypeMap;
        //console.log('SzBulkDataService.streamLoad: ', file, this.streamConnectionProperties, dataSourceMap, entityTypeMap);

        // event streams
        let retSubject  = new Subject<AdminStreamLoadSummary>();
        let retObs      = retSubject.asObservable();

        // set up subject used for aborting in progress subscriptions
        if(!this.streamLoadAbort$ || this.streamLoadAbort$ === undefined || (this.streamLoadAbort$ && this.streamLoadAbort$.closed)){
            this.streamLoadAbort$ = new Subject();
        }

        // file related
        file = file ? file : this.currentFile;
        let fileSize = file && file.size ? file.size : 0;
        let fileType = getFileTypeFromName(file);
        let fileName = (file && file.name) ? file.name : undefined;
        // how many records to send per 200 milliseconds
        // config value is per 1000ms, but .2s are better for UI draw
        let bulkRecordSendRate          = this.streamLoadConfig.uploadRate ? Math.floor(this.streamLoadConfig.uploadRate / 5) : -1;
        // record queues
        let readRecords                 = [];
        let readStreamComplete          = false;
        let sendStreamComplete          = false;
        // socket related
        let streamSocketEndpoint        = "/load-queue/bulk-data/records";
        let qsChar                      = '?';
        if(dataSourceMap) {
            streamSocketEndpoint        += `${qsChar}mapDataSources=${encodeURIComponent(JSON.stringify(dataSourceMap))}`;
            qsChar = '&';
        }
        if(entityTypeMap) {
            streamSocketEndpoint        += `${qsChar}mapEntityTypes=${encodeURIComponent(JSON.stringify(entityTypeMap))}`;
            qsChar = '&';
        }
        streamSocketEndpoint            += `${qsChar}eofSendTimeout=40&progressPeriod=60`;

        // construct summary object that we can report 
        // statistics to
        let summary: AdminStreamLoadSummary = {
            fileType: fileType,
            mediaType: fileType,
            fileName: fileName,
            fileSize: fileSize,
            fileLineEndingStyle: lineEndingStyle.unknown,
            characterEncoding: 'utf-8',
            recordCount: 0,
            loadedRecordCount: 0,
            incompleteRecordCount: 0,
            recordsWithRecordIdCount: 0,
            recordsWithDataSourceCount: 0,
            recordsWithEntityTypeCount: 0,
            sentRecordCount: 0,
            receivedRecordCount: 0,
            unsentRecordCount: 0,
            failedRecordCount: 0,
            missingDataSourceCount: 0,
            missingEntityTypeCount: 0,
            missingRecordIdCount: 0,
            resultsByDataSource: [],
            resultsByEntityType: [],
            bytesRead: 0,
            bytesSent: 0,
            bytesQueued: 0,
            fileColumns: [],
            dataSources: [],
            status: 'INCOMPLETE',
            complete: false
        }
        //if(!this.webSocketService.connected){
            // we need to reopen connection
        //    console.log('SzBulkDataService.streamLoad: websocket needs to be opened: ', this.webSocketService.connected, this.streamConnectionProperties);
            //console.log(`SzBulkDataService.streamLoad: ws to be opened: ${streamSocketEndpoint}`, this.streamConnectionProperties);
            this.webSocketService.reconnect(streamSocketEndpoint, "POST");
        //} else {
        //    console.log('SzBulkDataService.streamLoad: websocket thinks its still connected: ', this.webSocketService.connected, this.streamConnectionProperties);
        //}
        this.webSocketService.onMessageRecieved.pipe(
            filter( data => { return data !== undefined}),
            map( data => { return (data as AdminStreamLoadSummary) })
        ).subscribe((data: AdminStreamLoadSummary) => {
            // we change responses "recordCount" to "sentRecordCount" because that's what it really is
            // and re-assert our internal "recordCount" which includes all records read so far
            summary = Object.assign(summary, data, {recordCount: summary.recordCount, receivedRecordCount: data.recordCount});
            console.log('AdminBulkDataService.streamLoad.webSocketService.onMessageRecieved: ', summary, data);
            if(data && data.status === 'COMPLETED' && summary.sentRecordCount === summary.recordCount) {
                // all data sent
                summary.complete = true;
            }
            if(readStreamComplete && sendStreamComplete && summary.complete === true) {
                console.warn('sending _onStreamLoadComplete: ', summary);
                this._onStreamLoadComplete.next(summary);
            } else {
                console.log('stream not complete', readStreamComplete, sendStreamComplete, summary.complete);
            }
        });

        // initialize behavior subjects with base info
        this._onStreamLoadStarted.next(summary); // singleton
        this._onStreamLoadFileReadStarted.next(summary); // singleton
        retSubject.next(summary); // local

        // first create missing datasources and entity types
        let dataSourcesCreated      = false;
        let entityTypesCreated      = false;
        let onAllDataSourcesAndEntityTypesCreated   = new Subject<boolean>();
        let afterDataSourcesCreated = this.createNewDataSourcesFromMap(this.dataSourceMap);
        let afterEntityTypesCreated = this.createNewEntityTypesFromMap(this.entityTypeMap);
        // now create entity types
        afterDataSourcesCreated.pipe(
            takeUntil(this.streamLoadAbort$),
            take(1)
        ).subscribe((result: string[] | Error) => {
            if((result as string[]).length >= 0) {
                dataSourcesCreated = true;
                //console.log('SzBulkDataService.streamLoad: all data sources created', dataSourcesCreated);
                if(dataSourcesCreated && entityTypesCreated) {
                    onAllDataSourcesAndEntityTypesCreated.next(true);
                }
            }
        });
        afterEntityTypesCreated.pipe(
            takeUntil(this.streamLoadAbort$),
            take(1)
        ).subscribe((result) => {
            if((result as string[]).length >= 0) {
                entityTypesCreated = true;
                //console.log('SzBulkDataService.streamLoad: all entity types created', entityTypesCreated);
                if(dataSourcesCreated && entityTypesCreated) {
                    onAllDataSourcesAndEntityTypesCreated.next(true);
                }
            }
        });

        // read file contents as stream
        // parse to array of records
        this.parseRecordsFromFile(file, (streamStatus) => {
            // on stream complete, do thing
            //console.warn('SzBulkDataService.streamLoad: file stream read complete.');
            readStreamComplete = true;
            this._onStreamLoadProgress.next(summary);
            this._onStreamLoadFileReadComplete.next(summary);
            retSubject.next(summary); // local
        }).pipe(
            takeUntil(this.streamLoadAbort$)
        ).subscribe(
            (records) => {
                // do count inc before we add to summary otherwise well double
                summary.recordCount         = summary.recordCount + records.length;
                // now concat
                readRecords                 = readRecords.concat(records);
                summary.unsentRecordCount   = readRecords.length;
                this._onStreamLoadProgress.next(summary);
                this._onStreamLoadFileReadProgress.next(summary);
                retSubject.next(summary); // local
            }
        );
        
        // this is the main fn that actually sends the read records
        // to the websocket service
        let sendQueuedRecords = (records?: any) => {
            //console.warn('sendQueuedRecords: ', records, readRecords);
            if(readRecords && readRecords.length > 0) {
                // slice off a batch of records to send
                let currQueuePush   = readRecords && readRecords.length < bulkRecordSendRate || bulkRecordSendRate < 0 ? readRecords : readRecords.slice(0, bulkRecordSendRate);
                readRecords         = readRecords.slice(currQueuePush.length);

                // push them in to websocket (as quick as we read them - so cool)
                this.webSocketService.sendMessages(currQueuePush);

                // update metadata
                summary.sentRecordCount     = summary.sentRecordCount + currQueuePush.length;
                summary.unsentRecordCount   = readRecords.length;

                // check if everything has been sent
                if(readStreamComplete && summary.sentRecordCount === summary.recordCount && summary.recordCount > 0) {
                    // all messages sent
                    console.warn('stream load complete 1', summary);
                    sendStreamComplete = true;
                    if(summary.complete === true) {
                        console.warn('sending _onStreamLoadComplete 2: ', summary);
                        this._onStreamLoadComplete.next(summary);
                    }
                } else {
                    console.warn('the fuck?!?!', summary.sentRecordCount, summary.recordCount);
                    retSubject.next(summary); // local
                    this._onStreamLoadProgress.next(summary);
                }
            } else if(readRecords && readRecords.length <= 0) {
                // according to this we sent all the records, what went wrong
                //console.log('batch should be over. why is it still going?', readStreamComplete, summary.complete);
            }
        }
        // quick wrapper fn so we can (re)use this in a evt pipe
        let waitUntilDataSourcesAreValid = (): boolean => {
            return dataSourcesCreated;
        }
        // quick wrapper fn so we can (re)use this in a evt pipe
        let waitUntilEntityTypesCreated = (): boolean => {
            return entityTypesCreated;
        }

        // ------------ monitor status of queue, batch send records to socket ------------
        //if(bulkRecordSendRate > 0) {
            // set up an interval that expires once all records read have been sent
            let streamSendMon = timer(100, 200);
            streamSendMon.pipe(
                takeUntil(this.streamLoadAbort$),
                map(() => {
                    return summary;
                }),
                takeWhile( (summary: AdminStreamLoadSummary) => {
                    return (summary && !summary.complete) ? true : false;
                }),
                filter((summary: AdminStreamLoadSummary) => {
                    return summary && summary.recordCount > 0;
                }),
                filter( () => { return !this._streamLoadPaused; }),
                filter( waitUntilDataSourcesAreValid ),
                filter( waitUntilEntityTypesCreated )
            ).subscribe( sendQueuedRecords );
        //}
        
        // when ANYTHING changes, update the singleton "currentLoadResult" var so components can read status
        retObs.subscribe((summary: AdminStreamLoadSummary) => {
            this.currentLoadResult = summary;
        });

        // ---------------------------- on complete evt handlers ----------------------------
        /** after we have sent all data subscribe to the next socket message */
        /*
        //onAllStreamDataSent.pipe(
        //     take(1)
        //).subscribe((allSent) => {
            this.webSocketService.onMessageRecieved.pipe(
                filter( data => { return data !== undefined}),
            ).subscribe((data: AdminStreamLoadSummary) => {
                // we change responses "recordCount" to "sentRecordCount" because that's what it really is
                // and re-assert our internal "recordCount" which includes all records read so far
                summary = Object.assign(summary, data, {recordCount: summary.recordCount, sentRecordCount: data.recordCount});

                if(data && data.status === 'COMPLETED' && summary.sentRecordCount === summary.recordCount) {
                    // all data sent
                    summary.complete = true;
                }
                if(readStreamComplete && sendStreamComplete && summary.complete === true) {
                    this._onStreamLoadComplete.next(summary);
                }
            });
        //});*/

        // on end of read double-check if whole thing is complete
        /*
        this._onStreamLoadFileReadComplete.pipe(
            takeUntil(this.streamLoadAbort$),
            filter((summary: AdminStreamLoadSummary) => { return summary !== undefined;}),
            take(1),
            delay(5000)
        ).subscribe((summary: AdminStreamLoadSummary) => {
            if(readStreamComplete && summary && summary.sentRecordCount === summary.recordCount) {
                // set this to true to end batching loop Observeable
                summary.complete = true;
                this._onStreamLoadComplete.next(summary);
            }
            //console.log('_onStreamLoadReadComplete: ',readStreamComplete, summary);
        });*/

        // on end of records queue double-check if whole thing is complete
        this._onStreamLoadComplete.pipe(
            takeUntil(this.streamLoadAbort$),
            filter((summary: AdminStreamLoadSummary) => { return summary !== undefined;}),
            take(5),
            delay(2000)
        ).subscribe((summary: AdminStreamLoadSummary) => {
            // close connection
            //setTimeout(() => {
                console.log('closing connection: all data sent', summary);
                this.webSocketService.disconnect();
            //}, 3000)
        });

        return retObs;
    }

    /** parse records in json file via web worker through service
     * this is a hi-perf stream reader interface for parsing large json files
     */
    public parseRecordsFromFile(file: File, onComplete?: StreamReaderComplete): Observable<any[]> {
        let _readRecords    = [];
        let retSubject      = new Subject<any[]>();
        let retObs          = retSubject.asObservable();
        let streamReader = new SzStreamingFileRecordParser(file);

        streamReader.onStreamChunkParsed.subscribe((records: any[]) => {
            _readRecords.push(records);
            retSubject.next(records);
        });
        if(onComplete){
            //console.warn('SzBulkDataService.parseRecordsFromFile: onComplete handler passed to fn');
            streamReader.onStreamClosed.subscribe(onComplete);
        }
        streamReader.onStreamClosed.subscribe((state) => {
            //console.warn('SzBulkDataService.parseRecordsFromFile: stream closed.', state);
        });
        streamReader.read();
        return retObs;
    }

    /** get an array of datasources specified in a set of records */
    private getDataSourcesFromRecords(records: any[] | undefined): any[] | undefined {
        let retVal = undefined;
        if(records && (records as any[]).length > 0) {
            let recordsArray            = (records as any[]);
            let dataSourcesInRecords    = recordsArray.filter((record) => {
                return record && record.DATA_SOURCE && record.DATA_SOURCE !== undefined;
            }).map((record) => {
                return record && record.DATA_SOURCE ? record.DATA_SOURCE : undefined;
            }).filter( (dataSource, index, self) => {
                return self.indexOf(dataSource) === index;
            });
            if(dataSourcesInRecords && dataSourcesInRecords.length > 0) {
                retVal  = dataSourcesInRecords;
            }
        }
        return retVal;
    }
    /** get an array of entity types specified in a set of records */
    private getEntityTypesFromRecords(records: any[] | undefined): any[] | undefined {
        let retVal = undefined;
        if(records && (records as any[]).length > 0) {
            let recordsArray            = (records as any[]);
            let entityTypesInRecords    = recordsArray.filter((record) => {
                return record && record.ENTITY_TYPE && record.ENTITY_TYPE !== undefined;
            }).map((record) => {
                return record && record.ENTITY_TYPE ? record.ENTITY_TYPE : undefined;
            }).filter( (entityType, index, self) => {
                return self.indexOf(entityType) === index;
            });
            if(entityTypesInRecords && entityTypesInRecords.length > 0) {
                retVal  = entityTypesInRecords;
            }
        }
        return retVal;
    }
    /** helper method to determine if the "analysisByDataSource" collection in a stream summary
     * has a particular datasource.
     */
    private analysisByDataSouceHasSource(dataset: Array<SzDataSourceRecordAnalysis>, dataSource: string | null): boolean {
        let retValue = false;
        if(dataset && dataset.length) {
            retValue = dataset.some((analysisRow: SzDataSourceRecordAnalysis) => {
                if(analysisRow && analysisRow.dataSource === null && dataSource === null) {
                    return true;
                } else {
                    return (analysisRow.dataSource && analysisRow.dataSource === dataSource) ? true : false;
                }
            });
        }
        return retValue;
    }
    /** helper method to determine if the "analysisByEntityTypes" collection in a stream summary
     * has a particular datasource
     */
    private analysisByEntityTypeHasEntityType(dataset: Array<SzEntityTypeRecordAnalysis>, entityType: string): boolean {
        let retValue = false;
        if(dataset && dataset.length) {
            retValue = dataset.some((analysisRow: SzEntityTypeRecordAnalysis) => {
                return (analysisRow.entityType && analysisRow.entityType === entityType) ? true : false;
            });
        }
        return retValue;
    }
    /** helper method for updating properties of a AdminStreamAnalysisSummary or AdminStreamLoadSummary from a set of records */
    private updateStatsFromRecords(summary: AdminStreamAnalysisSummary | AdminStreamLoadSummary, records?: any[]) {
        /*
        if(summary && summary.recordCount < 10000){
            console.log('updateStatsFromRecords: ', records);
        }*/
        if(records && records.length > 0) {
            let missingDataSources          = 0;
            let missingEntityTypes          = 0;
            let missingRecordIds            = 0;
            let recordsWithRecordIdCount    = 0;
            let recordsWithDataSourceCount  = 0;
            let recordsWithEntityTypeCount  = 0;
            //let analysisByDataSource: Array<SzDataSourceRecordAnalysis>;
            //let analysisByEntityType: Array<SzEntityTypeRecordAnalysis>;
            let dataSources                 = [];
            let entityTypes                 = [];
            let recordsArray                = (records as any[]);
            let isAnalysisSummary   = (summary as AdminStreamLoadSummary).sentRecordCount !== undefined ? false : true; // only "AdminStreamLoadSummary" has "sentRecordCount"
            let summaryDsKey        = isAnalysisSummary ? 'analysisByDataSource' : 'resultsByDataSource';
            let summaryEtKey        = isAnalysisSummary ? 'analysisByEntityType' : 'resultsByEntityType';

            /**
             * This is what an "analysisByDataSource" node for records with no DS's defined looks like
             * @TODO add this functionality at index[0]
             * 
              dataSource: null
              recordCount: 3597
              recordsWithEntityTypeCount: 0
              recordsWithRecordIdCount: 3597
             */

            // more efficient to do this as a single loop
            recordsArray.forEach((record: any) => {
                if(record && record.DATA_SOURCE) {
                    // first append to count
                    recordsWithDataSourceCount++;
                    if(summary[summaryDsKey] && this.analysisByDataSouceHasSource(summary[summaryDsKey], record.DATA_SOURCE)) {

                        // just append
                        let sourceIndex = summary[summaryDsKey].findIndex((analysisRow: SzDataSourceRecordAnalysis) => {
                            return (analysisRow.dataSource && analysisRow.dataSource === record.DATA_SOURCE) ? true : false;
                        })
                        // add record to count
                        summary[summaryDsKey][ sourceIndex ].recordCount++; 
                        // if record has id, increment per-DS count
                        if(record && record.RECORD_ID) {
                            summary[summaryDsKey][ sourceIndex ].recordsWithRecordIdCount++;
                        }
                        // if record has entity type increment per-DS count
                        if(record && record.ENTITY_TYPE) {
                            summary[summaryDsKey][ sourceIndex ].recordsWithEntityTypeCount++;
                        }
                    } else {
                        // create                            
                        summary[summaryDsKey] = summary[summaryDsKey] ? summary[summaryDsKey] : [];
                        summary[summaryDsKey].push({
                            dataSource: record.DATA_SOURCE,
                            recordCount: 1,
                            recordsWithRecordIdCount: (record && record.RECORD_ID) ? 1 : 0,
                            recordsWithEntityTypeCount: (record && record.ENTITY_TYPE) ? 1 : 0
                        });
                    }
                } else if(record){
                    summary[summaryDsKey] = summary[summaryDsKey] ? summary[summaryDsKey] : [];
                    let sourceIndex = summary[summaryDsKey].findIndex((analysisRow: SzDataSourceRecordAnalysis) => {
                        return (analysisRow.dataSource === null) ? true : false;
                    });
                    // no datasource, put it in the {dataSource: null} entry
                    if(summary[summaryDsKey] && summary[summaryDsKey][sourceIndex]) {
                        // just append
                        //console.warn('NO DS for record. adding to "null" ', summary[summaryDsKey][sourceIndex]);
                        // add record to count
                        summary[summaryDsKey][ sourceIndex ].recordCount++; 
                        // if record has id, increment per-DS count
                        if(record && record.RECORD_ID) {
                            summary[summaryDsKey][ sourceIndex ].recordsWithRecordIdCount++;
                        }
                        // if record has entity type increment per-DS count
                        if(record && record.ENTITY_TYPE) {
                            summary[summaryDsKey][ sourceIndex ].recordsWithEntityTypeCount++;
                        }
                    } else {
                        // create null datasource
                        summary[summaryDsKey].push({
                            dataSource: null,
                            recordCount: 1,
                            recordsWithRecordIdCount: (record && record.RECORD_ID) ? 1 : 0,
                            recordsWithEntityTypeCount: (record && record.ENTITY_TYPE) ? 1 : 0
                        })
                        //console.warn('NO DS for record. created "null" ', summary[summaryDsKey].length, summary[summaryDsKey][0]);
                    }
                }
                if(record && (!record.DATA_SOURCE || record.DATA_SOURCE === undefined)) {
                    missingDataSources++;
                }
                if(record && (!record.ENTITY_TYPE || record.ENTITY_TYPE === undefined)) {
                    missingEntityTypes++;
                }
                if(record && record.ENTITY_TYPE) {
                    recordsWithEntityTypeCount++;
                    if(summary[summaryEtKey] && this.analysisByEntityTypeHasEntityType(summary[summaryEtKey], record.ENTITY_TYPE)) {
                        // just append
                        let sourceIndex = summary[summaryEtKey].findIndex((analysisRow: SzEntityTypeRecordAnalysis) => {
                            return (analysisRow.entityType && analysisRow.entityType === record.ENTITY_TYPE) ? true : false;
                        })
                        // add record to count
                        summary[summaryEtKey][ sourceIndex ].recordCount++; 
                        // if record has id, increment per-DS count
                        if(record && record.RECORD_ID) {
                            summary[summaryEtKey][ sourceIndex ].recordsWithRecordIdCount++;
                        }
                        // if record has datasource increment per-DS count
                        if(record && record.DATA_SOURCE) {
                            summary[summaryEtKey][ sourceIndex ].recordsWithDataSourceCount++;
                        }
                    } else {
                        // create
                        summary[summaryEtKey] = summary[summaryEtKey] ? summary[summaryEtKey] : [];
                        summary[summaryEtKey].push({
                            entityType: record.ENTITY_TYPE,
                            recordCount: 1,
                            recordsWithRecordIdCount: (record && record.RECORD_ID) ? 1 : 0,
                            recordsWithDataSourceCount: (record && record.DATA_SOURCE) ? 1 : 0
                        });
                    }
                } else if(record){
                    summary[summaryEtKey] = summary[summaryEtKey] ? summary[summaryEtKey] : [];
                    let sourceIndex = summary[summaryEtKey].findIndex((analysisRow: SzEntityTypeRecordAnalysis) => {
                        return (analysisRow.entityType === null) ? true : false;
                    });
                    // no entityType, put it in the {entityType: null} entry
                    if(summary[summaryEtKey] && summary[summaryEtKey][sourceIndex]) {
                        // just append
                        //console.warn('NO EntityType for record. adding to "null" ', summary[summaryEtKey][sourceIndex]);
                        // add record to count
                        summary[summaryEtKey][ sourceIndex ].recordCount++; 
                        // if record has id, increment per-DS count
                        if(record && record.RECORD_ID) {
                            summary[summaryEtKey][ sourceIndex ].recordsWithRecordIdCount++;
                        }
                        // if record has datasource increment per-DS count
                        if(record && record.DATA_SOURCE) {
                            summary[summaryEtKey][ sourceIndex ].recordsWithDataSourceCount++;
                        }
                    } else {
                        // create null entityType
                        summary[summaryEtKey].push({
                            entityType: null,
                            recordCount: 1,
                            recordsWithRecordIdCount: (record && record.RECORD_ID) ? 1 : 0,
                            recordsWithDataSourceCount: (record && record.DATA_SOURCE) ? 1 : 0
                        })
                        //console.warn('NO EntityType for record. created "null" ', summary[summaryEtKey].length, summary[summaryEtKey][0]);
                    }
                }
                if(record && (!record.RECORD_ID || record.RECORD_ID === undefined)) {
                    missingRecordIds++;
                }
                if(record && record.RECORD_ID) {
                    recordsWithRecordIdCount++;
                }
            });

            summary.missingDataSourceCount  = summary.missingDataSourceCount + missingDataSources;
            summary.missingEntityTypeCount  = summary.missingEntityTypeCount + missingEntityTypes;
            summary.missingRecordIdCount    = summary.missingRecordIdCount + missingRecordIds;
            dataSources                     = this.getDataSourcesFromRecords(recordsArray);
            entityTypes                     = this.getEntityTypesFromRecords(recordsArray);
            
            if(dataSources && dataSources.length > 0) {
                summary.dataSources      = summary.dataSources.concat(dataSources).filter((dataSource, index, self) => {
                    return self.indexOf(dataSource) === index;
                });
            }
            if(entityTypes && entityTypes.length > 0) {
                summary.entityTypes      = summary.entityTypes.concat(entityTypes).filter((entityType, index, self) => {
                    return self.indexOf(entityType) === index;
                });
            }
        }
    }
    /** helper method for creating new entity types from the entityTypeMap attribute set during the analysis mapping phase */
    private createNewEntityTypesFromMap(entityTypeMap?: { [key: string]: string }, analysis?: AdminStreamAnalysisSummary | SzBulkDataAnalysis): Observable<string[] | Error> {
        let _retVal     = new Subject<string[] | Error>();
        let retVal      = _retVal.asObservable();
        analysis        = analysis ?      analysis      : this.currentAnalysisResult;
        entityTypeMap   = entityTypeMap ? entityTypeMap : this.entityTypeMap;
        let promises    = [];
        const newEntityTypes = analysis.analysisByEntityType.filter(a => {
            const targetET = this.entityTypeMap[((a.entityType === null || a.entityType === undefined) ? "" : a.entityType )];
            return (targetET && this._entityTypes.indexOf(targetET) < 0);
        }).map( (b) => {
            return this.entityTypeMap[(b.entityType === null || b.entityType === undefined ? "" : b.entityType)];
        }).filter((entityType, index, self) => {
            return self.indexOf(entityType) === index;
        });
        if (newEntityTypes.length > 0) {
            //console.log('create new entity types: ', newEntityTypes);
            let simResp = false;
            const pTemp = this.createEntityTypes(newEntityTypes).toPromise();
            /*const pTemp   = new Promise((resolve, reject) =>{
                setTimeout(() => {
                    console.log('resolving entity creation promise for: ', newEntityTypes );
                    resolve(newEntityTypes);
                }, 3000);
            });*/
            promises.push( pTemp );
        }
        let promise = Promise.resolve([]);
        promise     = Promise.all(promises);
        promise.then((entityTypes: string[]) => {
            //console.log('all entity types created', entityTypes);
            _retVal.next(entityTypes);
        }).catch((err => {
            // return false
            //console.log('entity creation error', err);
            _retVal.next(err);
        }));
        return retVal;
    }
    /** helper method for creating new datasources from the dataSourcesMap attribute set during the analysis mapping phase */
    private createNewDataSourcesFromMap(dataSourceMap?: { [key: string]: string }, analysis?: AdminStreamAnalysisSummary | SzBulkDataAnalysis): Observable<string[] | Error> {
        let _retVal     = new Subject<string[] | Error>();
        let retVal      = _retVal.asObservable();
        analysis        = analysis ?      analysis      : this.currentAnalysisResult;
        dataSourceMap   = dataSourceMap ? dataSourceMap : this.dataSourceMap;
        let promises    = [];
        const newDataSources = analysis.analysisByDataSource.filter(a => {
            const targetDS = this.dataSourceMap[((a.dataSource === null || a.dataSource === undefined) ? "" : a.dataSource)];
            return (targetDS && this._dataSources.indexOf(targetDS) < 0);
        }).map( (b) => {
            return this.dataSourceMap[(b.dataSource === null || b.dataSource === undefined ? "" :  b.dataSource)];
        }).filter((dataSource, index, self) => {
            return self.indexOf(dataSource) === index;
        });
        if (newDataSources.length > 0) {
            //console.log('create new datasources: ', newDataSources);
            let simResp = false;
            const pTemp = this.createDataSources(newDataSources).toPromise();
            
            /*const pTemp   = new Promise((resolve, reject) =>{
                setTimeout(() => {
                    console.log('resolving ds creation promise for: ', newDataSources );
                    resolve(newDataSources);
                }, 3000);
            })*/
            promises.push( pTemp );
        }
        let promise = Promise.resolve([]);
        promise     = Promise.all(promises);
        promise.then((datasources: string[]) => {
            //console.log('all datasources created', datasources);
            _retVal.next(datasources);
        }).catch((err => {
            //console.log('NOT all datasources created', err);
            _retVal.next(err);
        }));
        return retVal;
    }

}