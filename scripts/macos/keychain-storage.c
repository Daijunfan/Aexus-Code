/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
#include <node_api.h>
#include <Security/Security.h>
#include <string.h>

static const char *service = "Aexus Code Safe Storage";
static const char *account = "Aexus Code Key";

static napi_value result(napi_env env, OSStatus status) {
	napi_value value;
	napi_create_int32(env, status, &value);
	return value;
}

static OSStatus read_key(UInt32 *length, void **data) {
	return SecKeychainFindGenericPassword(NULL, (UInt32)strlen(service), service,
		(UInt32)strlen(account), account, length, data, NULL);
}

static napi_value check(napi_env env, napi_callback_info callback) {
	SecKeychainSetUserInteractionAllowed(false);
	UInt32 length = 0;
	void *data = NULL;
	OSStatus status = read_key(&length, &data);
	if (data) { SecKeychainItemFreeContent(NULL, data); }
	return result(env, status);
}

static napi_value install(napi_env env, napi_callback_info callback) {
	SecKeychainSetUserInteractionAllowed(false);
	napi_value argument;
	size_t count = 1, length = 0;
	void *data = NULL;
	napi_get_cb_info(env, callback, &count, &argument, NULL, NULL);
	if (count != 1 || napi_get_buffer_info(env, argument, &data, &length) != napi_ok || !length) {
		return result(env, errSecParam);
	}
	SecTrustedApplicationRef app = NULL;
	OSStatus status = SecTrustedApplicationCreateFromPath(NULL, &app);
	if (status) { return result(env, status); }
	CFArrayRef trusted = CFArrayCreate(NULL, (const void **)&app, 1, &kCFTypeArrayCallBacks);
	SecAccessRef access = NULL;
	status = SecAccessCreate(CFSTR("Aexus Code Safe Storage"), trusted, &access);
	CFRelease(trusted);
	CFRelease(app);
	if (status) { return result(env, status); }
	SecKeychainItemRef previous = NULL;
	status = SecKeychainFindGenericPassword(NULL, (UInt32)strlen(service), service,
		(UInt32)strlen(account), account, NULL, NULL, &previous);
	if (!status) {
		status = SecKeychainItemDelete(previous);
		CFRelease(previous);
	} else if (status == errSecItemNotFound) {
		status = errSecSuccess;
	}
	if (!status) {
		SecKeychainAttribute attributes[] = {
			{ kSecServiceItemAttr, (UInt32)strlen(service), (void *)service },
			{ kSecAccountItemAttr, (UInt32)strlen(account), (void *)account }
		};
		SecKeychainAttributeList list = { 2, attributes };
		status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list,
			(UInt32)length, data, NULL, access, NULL);
	}
	CFRelease(access);
	if (!status) {
		UInt32 actualLength = 0;
		void *actual = NULL;
		status = read_key(&actualLength, &actual);
		if (!status && (actualLength != length || memcmp(actual, data, length))) { status = errSecDecode; }
		if (actual) { SecKeychainItemFreeContent(NULL, actual); }
	}
	return result(env, status);
}

NAPI_MODULE_INIT() {
	napi_property_descriptor methods[] = {
		{ "check", NULL, check, NULL, NULL, NULL, napi_default, NULL },
		{ "install", NULL, install, NULL, NULL, NULL, napi_default, NULL }
	};
	napi_define_properties(env, exports, 2, methods);
	return exports;
}
