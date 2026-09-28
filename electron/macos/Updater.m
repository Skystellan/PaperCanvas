#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>

// A separate native updater lets Sparkle show its standard download/install UI
// and request a normal quit of Electron, including PaperCanvas's save-on-close.
@interface UpdaterDelegate : NSObject <NSApplicationDelegate, SPUUpdaterDelegate>
@property(nonatomic, strong) SPUUpdater *updater;
@end

@implementation UpdaterDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSString *helper = NSBundle.mainBundle.bundlePath;
    NSBundle *host = [NSBundle bundleWithPath:[helper stringByAppendingPathComponent:@"../../.."]];
    SPUStandardUserDriver *driver = [[SPUStandardUserDriver alloc] initWithHostBundle:host delegate:nil];
    self.updater = [[SPUUpdater alloc] initWithHostBundle:host applicationBundle:host userDriver:driver delegate:self];
    self.updater.userAgentString = @"PaperCanvas";
    NSError *error = nil;
    if (![self.updater startUpdater:&error]) {
        [NSApp presentError:error];
        [NSApp terminate:nil];
        return;
    }
    [NSApp activateIgnoringOtherApps:YES];
    [self.updater checkForUpdates];
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    // Let Sparkle finish unwinding its user driver before exiting this helper.
    dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        UpdaterDelegate *delegate = [UpdaterDelegate new];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
