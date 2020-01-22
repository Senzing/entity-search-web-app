import { Component, OnInit, ViewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { SzDataSourcesService } from '@senzing/sdk-components-ng';
import { AdminAuthService } from 'src/app/services/admin.service';

@Component({
  selector: 'admin-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class AdminLoginComponent implements OnInit {

  constructor(
    private titleService: Title,
    private adminAuth: AdminAuthService
  ) { }

  ngOnInit() {
    this.titleService.setTitle( 'Login' );
    this.adminAuth.onAdminModeChange.subscribe( (newVal) => {
      console.log('AdminLoginComponent.onAdminModeChange: ', newVal);
      if(this.adminAuth.isAdminModeEnabled && this.adminAuth.isAuthenticated ) {
        // redirect to home instead
      }
    });
  }
}
