import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wildbloom.app',
  appName: 'Wildbloom',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#1a1f17',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      // Status-bar (small) icon for every scheduled notification. Lives at
      // res/drawable-{density}/ic_stat_icon.png — a white silhouette of the
      // logo. Android tints it with iconColor; without this the system falls
      // back to the generic info icon.
      smallIcon: 'ic_stat_icon',
      iconColor: '#1a1f17',
    },
  },
};

export default config;
