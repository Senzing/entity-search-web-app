import { AfterViewInit, Component, Inject, OnDestroy, OnInit } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
//import { WebSocketService } from '../../services/websocket.service';
import { SzPocWebSocketService, SzWebSocketConnectionParameters} from '@senzing/sdk-components-ng';
import { AdminBulkDataService } from '../../services/admin.bulk-data.service';

//import { AdminStreamConnProperties } from '../../services/admin.bulk-data.service';
import { AdminStreamAnalysisConfig, AdminStreamLoadConfig, AdminStreamUploadRates } from '@senzing/sdk-components-ng';
import { takeUntil } from 'rxjs/operators';
import { Subject } from 'rxjs';

@Component({
    selector: 'stream-abort-dialog',
    templateUrl: 'stream-abort-dialog.component.html',
    styleUrls: ['stream-abort-dialog.component.scss']
  })
  export class AdminStreamAbortDialogComponent implements OnInit, OnDestroy, AfterViewInit {
    /** subscription to notify subscribers to unbind */
    public unsubscribe$ = new Subject<void>();

    constructor(
      public dialogRef: MatDialogRef<AdminStreamAbortDialogComponent>,
      private webSocketService: SzPocWebSocketService,
      private adminBulkDataService: AdminBulkDataService
      ) {
    }
    /**
     * listen for websocket service errors
     */
    ngOnInit() {}

    ngAfterViewInit() {}

    /**
     * unsubscribe event streams
     */
    ngOnDestroy() {
      this.unsubscribe$.next();
      this.unsubscribe$.complete();
    }
  
    onNoClick(): void {
      this.dialogRef.close(false);
    }
    onYesClick(): void {
      this.dialogRef.close(true);
    }
  }