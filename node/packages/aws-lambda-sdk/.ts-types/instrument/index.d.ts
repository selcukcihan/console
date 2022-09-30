interface SdkOptions {
  orgId?: string;
  disableHttpMonitoring?: boolean;
  disableRequestMonitoring?: boolean;
  disableResponseMonitoring?: boolean;
  disableAwsSdkMonitoring?: boolean;
}

declare function instrument(handler: Function, options?: SdkOptions): Function;
export default instrument;