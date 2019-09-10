/* @flow */

import { memoize, extendUrl, uniqueID, getUserAgent } from 'belter/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { PLATFORM, FUNDING } from '@paypal/sdk-constants/src';

import type { CreateOrder, CreateBillingAgreement, CreateSubscription, OnApprove, OnCancel, OnShippingChange, OnError, GetPageURL } from '../button/props';
import type { ProxyWindow } from '../types';
import { NATIVE_WEBSOCKET_URL, HTTP_SOCKET_URL, EXPERIENCE_URI } from '../config';
import { webSocket, httpSocket, promiseNoop, getLogger, redirectTop, type MessageSocket } from '../lib';
import { createAccessToken } from '../api';
import { SMART_PAYMENT_BUTTONS } from '../constants';

const MESSAGE = {
    DETECT_APP: 'detectApp',
    GET_PROPS:  'getProps',
    ON_APPROVE: 'onApprove',
    ON_CANCEL:  'onCancel',
    ON_ERROR:   'onError'
};

let isNativeCheckoutInstalled = false;
let isNativeCheckoutWebsocketAvailable = true;

type NativeEligibleProps = {|
    win : ?ProxyWindow,
    platform : $Values<typeof PLATFORM>,
    fundingSource : $Values<typeof FUNDING>,
    onShippingChange : ?OnShippingChange,
    createBillingAgreement : ?CreateBillingAgreement,
    createSubscription : ?CreateSubscription
|};

export function isNativeEligible({ win, platform, fundingSource, onShippingChange, createBillingAgreement, createSubscription } : NativeEligibleProps) : boolean {
    if (win) {
        return false;
    }

    if (platform !== PLATFORM.MOBILE) {
        return false;
    }

    if (onShippingChange) {
        return false;
    }

    if (fundingSource !== FUNDING.PAYPAL) {
        return false;
    }

    if (createBillingAgreement || createSubscription) {
        return false;
    }

    if (window.xprops.enableNativeCheckout) {
        return true;
    }
    
    if (!isNativeCheckoutInstalled) {
        return false;
    }

    return true;
}

const getNativeSocket = memoize(() : { socket : MessageSocket, sessionUID : string } => {

    const sessionUID = uniqueID();

    const socket = isNativeCheckoutWebsocketAvailable
        ? webSocket({
            sessionUID,
            url:        NATIVE_WEBSOCKET_URL,
            appName:    SMART_PAYMENT_BUTTONS,
            appVersion: window.paypal.version
        })
        : httpSocket({
            sessionUID,
            url:        HTTP_SOCKET_URL,
            appName:    SMART_PAYMENT_BUTTONS,
            appVersion: window.paypal.version
        });

    return { socket, sessionUID };
});

type SetupNativeProps = {|
    platform : $Values<typeof PLATFORM>
|};

export function setupNative({ platform } : SetupNativeProps) : ZalgoPromise<void> {
    return ZalgoPromise.try(() => {
        if (platform !== PLATFORM.MOBILE || !window.xprops.enableNativeCheckout) {
            return;
        }
    
        const { socket } = getNativeSocket();
    
        return socket.send(MESSAGE.DETECT_APP).then(() => {
            getLogger().info('native_sdk_detected');
            isNativeCheckoutInstalled = true;
        }, err => {
            getLogger().info('native_sdk_not_detected', { err: err.stack || err.toString() });
            isNativeCheckoutWebsocketAvailable = false;
        });
    });


}

type NativeProps = {|
    createOrder : CreateOrder,
    onApprove : OnApprove,
    onCancel : OnCancel,
    onError : OnError,
    commit : boolean,
    clientID : string,
    fundingSource : $Values<typeof FUNDING>,
    getPageUrl : GetPageURL
|};

type NativeInstance = {|
    start : () => ZalgoPromise<void>,
    close : () => ZalgoPromise<void>,
    triggerError : (mixed) => ZalgoPromise<void>
|};

export function initNative(props : NativeProps) : NativeInstance {
    const { createOrder, onApprove, onCancel, onError, commit, clientID, getPageUrl } = props;

    const start = () => {
        return ZalgoPromise.try(() => {
            const accessTokenPromise = createAccessToken(clientID);
            const orderPromise = createOrder();
            const pageUrlPromise = getPageUrl();

            const { socket, sessionUID } = getNativeSocket();
    
            socket.on(MESSAGE.GET_PROPS, () => {
                return ZalgoPromise.all([
                    accessTokenPromise, orderPromise, pageUrlPromise
                ]).then(([ facilitatorAccessToken, orderID, pageUrl ]) => {
                    const userAgent = getUserAgent();

                    return {
                        orderID,
                        facilitatorAccessToken,
                        pageUrl,
                        commit,
                        userAgent
                    };
                });
            });
    
            socket.on(MESSAGE.ON_APPROVE, ({ data: { payerID, paymentID, billingToken } }) => {
                return onApprove({ payerID, paymentID, billingToken }, { restart: start });
            });
    
            socket.on(MESSAGE.ON_CANCEL, () => {
                return onCancel();
            });

            socket.on(MESSAGE.ON_ERROR, ({ data : { error } }) => {
                return onError(new Error(error.message));
            });

            redirectTop(extendUrl(EXPERIENCE_URI.CHECKOUT, { query: { sessionUID } }));
        });
    };

    return {
        start,
        close:        promiseNoop,
        triggerError: err => {
            throw err;
        }
    };
}