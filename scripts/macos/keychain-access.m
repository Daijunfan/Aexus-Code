/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
#import <Foundation/Foundation.h>
#import <Security/Security.h>

int main(int argc, const char **argv) {
	@autoreleasepool {
		// This stable signed process owns only the encrypted Aexus credential key.
		// It never stores the login password, and no keychain operation may show UI.
		SecKeychainSetUserInteractionAllowed(false);
		BOOL check = argc > 1 && strcmp(argv[1], "--check") == 0;
		NSString *directory = NSProcessInfo.processInfo.arguments[0].stringByStandardizingPath.stringByDeletingLastPathComponent;
		NSString *module = [directory stringByAppendingPathComponent:@"keychain-storage.node"];
		NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
		environment[@"ELECTRON_RUN_AS_NODE"] = @"1";
		[environment removeObjectForKey:@"NODE_OPTIONS"];
		[environment removeObjectForKey:@"DYLD_INSERT_LIBRARIES"];
		NSTask *task = [NSTask new];
		task.executableURL = [NSURL fileURLWithPath:@"/Applications/Aexus Code.app/Contents/MacOS/Aexus Code"];
		task.environment = environment;
		task.arguments = @[@"-e", check
			? @"const s=require(process.argv[1]).check();console.log(JSON.stringify({installedAppKeychainRead:s,userInteractionAllowed:false}));process.exitCode=s?1:0;"
			: @"const b=require('node:fs').readFileSync(0);const s=require(process.argv[1]).install(b);b.fill(0);console.log(JSON.stringify({installedAppKeychainRefresh:s,userInteractionAllowed:false}));process.exitCode=s?1:0;", module];
		NSPipe *pipe = [NSPipe pipe];
		task.standardInput = pipe;
		UInt32 length = 0;
		void *key = NULL;
		if (!check) {
			OSStatus status = SecKeychainFindGenericPassword(NULL, (UInt32)strlen("Aexus Code Keychain Bridge"), "Aexus Code Keychain Bridge", 14, "Aexus Code Key", &length, &key, NULL);
			if (status) { printf("{\"bridgeReadStatus\":%d,\"userInteractionAllowed\":false}\n", (int)status); return 1; }
		}
		NSError *error = nil;
		if (![task launchAndReturnError:&error]) {
			if (key) { SecKeychainItemFreeContent(NULL, key); }
			fprintf(stderr, "Unable to run Aexus keychain migration: %s\n", error.localizedDescription.UTF8String);
			return 2;
		}
		if (key) {
			[pipe.fileHandleForWriting writeData:[NSData dataWithBytesNoCopy:key length:length freeWhenDone:NO]];
			memset(key, 0, length);
			SecKeychainItemFreeContent(NULL, key);
		}
		[pipe.fileHandleForWriting closeFile];
		[task waitUntilExit];
		return task.terminationStatus;
	}
}
