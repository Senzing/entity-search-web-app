import { Component, OnInit, Inject, ViewContainerRef, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { SzPrefsService, SzAdminService, SzDataSourcesService, SzBulkDataService } from '@senzing/sdk-components-ng';

import {
  SzBulkDataAnalysis,
  SzBulkLoadResult,
} from '@senzing/rest-api-client-ng';
import { Subject } from 'rxjs';
import { AdminBulkDataService, AdminStreamAnalysisSummary, AdminStreamLoadSummary } from '../../services/admin.bulk-data.service';
import { filter, take, takeUntil } from 'rxjs/operators';
import { SzStreamingFileRecordParser } from '../../common/streaming-file-record-parser';
import { NgForm } from '@angular/forms';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { AdminStreamAbortDialogComponent } from 'src/app/common/stream-abort-dialog/stream-abort-dialog.component';

/**
 * Provides an interface for loading files in to a datasource.
 * allowed file types are:
 *
 * @example
 * <sz-bulk-data-load></sz-bulk-data-load>
 *
 * @export
 */
@Component({
  selector: 'admin-bulk-data-load',
  templateUrl: './admin-bulk-data-load.component.html',
  styleUrls: ['./admin-bulk-data-load.component.scss']
})
export class AdminBulkDataLoadComponent implements OnInit, AfterViewInit, OnDestroy {
  /** subscription to notify subscribers to unbind */
  public unsubscribe$ = new Subject<void>();
  /** show the analysis summary embedded in component */
  private _showAnalysis = true;
  /** show the load summary embedded in component */
  private _showResults = true;

  /** file picker element */
  @ViewChild('filePicker')
  private filePicker: ElementRef;
  /** file picker form (needed to reset) */
  @ViewChild('szAdminFileSelectForm')
  private filePickerForm: NgForm;

  /** get the current analysis from service */
  public get analysis(): SzBulkDataAnalysis | AdminStreamAnalysisSummary {
    return this.adminBulkDataService.currentAnalysisResult;
  }
  @Input() public set analysis(value: SzBulkDataAnalysis | AdminStreamAnalysisSummary) {
    if(value) { 
      if((value as AdminStreamAnalysisSummary).bytesSent >= 0) {
        this.adminBulkDataService.currentAnalysisResult = value as AdminStreamAnalysisSummary; 
      } else {
        this.adminBulkDataService.currentAnalysisResult = value as SzBulkDataAnalysis; 
      }
    }
  }

  /** use websockets to stream file input records and results*/
  @Input() public set useSocketStream(value: boolean) {
    this.adminBulkDataService.useStreaming = value;
    if(this.adminBulkDataService.useStreaming) {
      this._supportedFileTypes = [
        '.JSON',
        '.json',
        '.jsonl',
        '.JSONL'
      ]
    }
  }
  /** whether or not to use streaming sockets for analysis and loading */
  public get useSocketStream() {
    return this.adminBulkDataService.useStreaming;
  }
  public get canOpenStreamSocket(): boolean {
    return this.adminBulkDataService.canOpenStreamSocket;
  }
  private _streamAnalysisComplete = false;
  public get isStreamAnalysisComplete(): boolean {
    return this._streamAnalysisComplete;
  }
  private _isStreamingAnalysisInProgress  = false;
  private _isStreamingLoadInProgress      = false;
  private _isStreamingLoadComplete        = false;
  public get isStreamingAnalysisInProgress(): boolean { return this._isStreamingAnalysisInProgress; }
  public get isStreamingLoadInProgress(): boolean { return this._isStreamingAnalysisInProgress; }
  public get isStreamingLoadComplete(): boolean { return this._isStreamingLoadComplete; }

  /** does user have admin rights */
  public get adminEnabled() {
    return this.adminService.adminEnabled;
  }
  /** is the current server instance read only */
  public get readOnly() {
    return this.adminService.readOnly;
  }
  /** set result of load operation from service */
  @Input() public set result(value: SzBulkLoadResult | AdminStreamLoadSummary) {
    if(value) { 
      if((value as AdminStreamLoadSummary).bytesSent >= 0) {
        this.adminBulkDataService.currentLoadResult = value as AdminStreamLoadSummary; 
      } else {
        this.adminBulkDataService.currentLoadResult = value as SzBulkLoadResult; 
      }
    }
  }
  /** get result of load operation from service */
  public get result(): SzBulkLoadResult | AdminStreamLoadSummary {
    return this.adminBulkDataService.currentLoadResult;
  }
  /** show the analysis summary embedded in component */
  public get showAnalysis(): boolean {
    return this._showAnalysis;
  }
  /** show the load summary embedded in component */
  public get showResults(): boolean {
    return this._showResults;
  }
  /** @alias showSummary */
  @Input() public set showSummaries(value: boolean) {
    this.showSummary = value;
  }
  /** whether or not to show the analysis and load summaries embedded in component */
  @Input() public set showSummary(value: boolean) {
    this._showAnalysis = value;
    this._showResults = value;
  }
  public get currentError(): Error {
    return this.adminBulkDataService.currentError;
  }
  /** file types allowed to select in dropdown */
  private _supportedFileTypes = [
    '.JSON',
    '.json',
    '.csv',
    '.CSV',
    '.jsonl',
    '.JSONL'
  ]
  public get supportedFileTypes(): string {
    return this._supportedFileTypes.join(',');
  }
  public set supportedFileTypes(value: string) {
    this._supportedFileTypes = value.split(',');
  }

  constructor(
    public prefs: SzPrefsService,
    private adminService: SzAdminService,
    //private bulkDataService: SzBulkDataService,
    public dialog: MatDialog,
    private adminBulkDataService: AdminBulkDataService,
    public viewContainerRef: ViewContainerRef) {}

    ngOnInit() {}
    ngAfterViewInit() {
      // if its the users first file load and they just verified stream host
      // immediately prompt for file selection
      this.adminBulkDataService.onUseStreamingSocketChange.pipe(
        takeUntil(this.unsubscribe$),
        filter( (useStreamingForLoad: boolean) => {
          return useStreamingForLoad && !this.adminBulkDataService.file && this.adminBulkDataService.streamConnectionProperties.connectionTest;
        })
      ).subscribe( (useStreaming) => {
        console.info('AdminBulkDataLoadComponent.adminBulkDataService.onUseStreamingSocketChange: '+ useStreaming);
        this.chooseFileInput();
      });

      this.adminBulkDataService.onStreamAnalysisProgress.pipe(
        takeUntil(this.unsubscribe$),
        filter( (value) => { return value !== undefined; })
      ).subscribe((summary) =>{
        this._isStreamingAnalysisInProgress = true;
      });
      this.adminBulkDataService.onStreamLoadProgress.pipe(
        takeUntil(this.unsubscribe$),
        filter( (value) => { return value !== undefined; })
      ).subscribe((summary) =>{
        this._isStreamingLoadInProgress = true;
      });
      this.adminBulkDataService.onStreamAnalysisComplete.pipe( 
        takeUntil(this.unsubscribe$),
        filter( (value) => { return value !== undefined; })
      ).subscribe((summary: AdminStreamAnalysisSummary) => {
        this._streamAnalysisComplete = summary ? summary.complete : false;
        this._isStreamingAnalysisInProgress = summary ? !summary.complete : true;
      });
      this.adminBulkDataService.onStreamLoadComplete.pipe(
        takeUntil(this.unsubscribe$),
        filter( (value) => { return value !== undefined; })
      ).subscribe((summary: AdminStreamLoadSummary) =>{
        this._isStreamingLoadInProgress = summary ? !summary.complete : false;
        this._isStreamingLoadComplete   = summary ? summary.complete : false;
      });

      /** when the bulk data service clears it's analysis related properties and event streams */
      this.adminBulkDataService.onAnalysisCleared.pipe(
        takeUntil(this.unsubscribe$)
      ).subscribe( (cleared) => {
        this._streamAnalysisComplete        = false;
        this._isStreamingAnalysisInProgress = false;
      });
      /** when the bulk data service clears it's import related properties and event streams */
      this.adminBulkDataService.onImportJobCleared.pipe(
        takeUntil(this.unsubscribe$)
      ).subscribe( (cleared) => {
        this._isStreamingLoadInProgress = false;
        this._isStreamingLoadComplete = false;
      });

      /** stream state props */
      this._streamAnalysisComplete  = false;
      this._isStreamingLoadComplete = false;
      this._isStreamingAnalysisInProgress = false;
      this._isStreamingLoadInProgress = false;
    }
    /**
     * unsubscribe when component is destroyed
     */
    ngOnDestroy() {
      this.unsubscribe$.next();
      this.unsubscribe$.complete();
    }

    /** take the current file focus and pass to api load endpoint */
    public onFileInputChange(event: Event) {
      //console.log('onFileInputChange: ', event);
      //this.adminBulkDataService.isAnalyzingFile = true;
      //this.adminBulkDataService.analyzingFile.next(true);
      const target: HTMLInputElement = <HTMLInputElement> event.target;
      const fileList = target.files;
      /*if(this.useSocketStream && this.canOpenStreamSocket) {
        this.onFileInputStreamAnalysis(event);
        return;
      }*/
      this.adminBulkDataService.file = fileList.item(0);
    }
    /** upload a file for analytics */
    public chooseFileInput(event?: Event) {
      if(event && event.preventDefault) event.preventDefault();
      if(event && event.stopPropagation) event.stopPropagation();
      if(this.filePicker && this.filePicker.nativeElement) {
        try {
          this.filePicker.nativeElement.click();
        } catch(e) {
          console.warn('AdminBulkDataLoadComponent.filePicker.nativeElement.click error', e);
        }
      } else {
        console.warn('AdminBulkDataLoadComponent.filePicker.nativeElement missing');
      }
    }
    private _abortDialogRef: MatDialogRef<AdminStreamAbortDialogComponent>;

    /** upload a file for analytics */
    public clearAndChooseFileInput(event?: Event) {
      if(event && event.preventDefault) event.preventDefault();
      if(event && event.stopPropagation) event.stopPropagation();
      // @TODO check to see if analysis or load is in progress
      let isProcessInProgress = this._isStreamingAnalysisInProgress || this._isStreamingLoadInProgress;
      if(isProcessInProgress) {
        // emit modal confirmation first
        this._abortDialogRef = this.dialog.open(AdminStreamAbortDialogComponent, {
          width: '600px',
          data: {
            streamConnectionProperties: this.adminBulkDataService.streamConnectionProperties,
            streamAnalysisConfig: this.adminBulkDataService.streamAnalysisConfig,
            streamLoadConfig: this.adminBulkDataService.streamLoadConfig,
          }
        });
        this._abortDialogRef.afterClosed().subscribe((result: boolean | undefined) => {
          console.log(`Dialog result: `, result);
          this._abortDialogRef = undefined;
          if(result === true){
            // @TODO stop current process
            this.adminBulkDataService.abort();
            // clear state
            this.clear();
          }
        });
      } else {
        this.clear();
        this.chooseFileInput(event);
      }
    }
    /** take the current file focus and pass to api load endpoint */
    public loadFile(event: Event) {
      this.adminBulkDataService.load();
    }

    /** take the current file focus and pass to api load endpoint */
    public loadFileFS(event: Event) {
      this.adminBulkDataService.streamLoad(this.adminBulkDataService.file)
    }

    /** clear the current bulkloader focal state */
    public clear() {
      this.adminBulkDataService.clear();
      this.filePickerForm.resetForm();
      this.filePickerForm.reset();
      
      /** file picker */
      if(this.filePicker && this.filePicker.nativeElement){
        this.filePicker.nativeElement.value = "";
      }
    }

    public toggleStreamConnection(event: Event) {
      console.log('toggleStreamConnection: ', this.adminBulkDataService.toggleStreamConnection() );
    }
    public getStreamConnectionProperties(event: Event) {
      let streamConnProperties = this.adminBulkDataService.streamConnectionProperties;

      console.log('getStreamConnectionProperties: ', JSON.stringify(streamConnProperties, undefined, 2) );
    }
}
