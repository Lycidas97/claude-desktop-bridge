import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.localbridge.mobile",
  appName: "Bridge",
  webDir: "dist",
  backgroundColor: "#000000",
  ios: {
    contentInset: "always",
    preferredContentMode: "mobile",
    scheme: "Bridge",
  },
  android: {
    backgroundColor: "#000000",
  },
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_bridge",
      iconColor: "#D97757",
    },
  },
};

export default config;
