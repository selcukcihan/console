package slslambda

import (
	"context"
	"github.com/aws/aws-lambda-go/lambda"
	"runtime/debug"
	"time"
)

var initializationStart = time.Now()

// Start starts handler function with Serverless instrumentation.
func Start(handlerFunc any, options ...Option) {
	lambda.Start(wrap(handlerFunc, options))
}

func wrap(userHandlerFunc any, options []Option) (handlerFunc any) {
	defer func() {
		if r := recover(); r != nil {
			debugLog("recover panic in wrap:", r, string(debug.Stack()))
			// return user handler
			handlerFunc = userHandlerFunc
		}
	}()
	w, err := newWrapper(options...)
	if err != nil {
		debugLog("cannot instrument function:", err)
		// return user handler
		return userHandlerFunc
	}
	return w.Wrap(lambda.NewHandler(userHandlerFunc), initializationStart)
}

// Option is used to customize the instrumentation.
type Option = func(c *wrapper)

// WithEnvironment allows for associating custom environment with telemetry data sent.
func WithEnvironment(env string) Option {
	return func(w *wrapper) {
		w.environment = env
	}
}

func CaptureError(ctx context.Context, err error) {
	span, ctxErr := currentSpanFromContext(ctx)
	if ctxErr != nil {
		debugLog("capture error:", ctxErr)
		return
	}
	span.captureError(err)
}

func CaptureWarning(ctx context.Context, msg string) {
	span, ctxErr := currentSpanFromContext(ctx)
	if ctxErr != nil {
		debugLog("capture warning:", ctxErr)
		return
	}
	span.captureWarning(msg)
}

func WithSpan(ctx context.Context, name string) context.Context {
	span, ctxErr := currentSpanFromContext(ctx)
	if ctxErr != nil {
		debugLog("with span:", ctxErr)
		return ctx
	}
	return span.newChild(ctx, name)
}

func Close(ctx context.Context) {
	span, ctxErr := currentSpanFromContext(ctx)
	if ctxErr != nil {
		debugLog("close:", ctxErr)
		return
	}
	span.Close()
}

func AddTags(ctx context.Context, tags map[string]string) {
	span, ctxErr := currentSpanFromContext(ctx)
	if ctxErr != nil {
		debugLog("add tag:", ctxErr)
		return
	}
	span.addTags(tags)
}

func AddTag(ctx context.Context, key, value string) {
	AddTags(ctx, map[string]string{key: value})
}
