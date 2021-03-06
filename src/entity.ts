import * as debug from "debug";
import {
    DurableEntityBindingInfo,
    DurableEntityContext,
    EntityId,
    EntityState,
    IEntityFunctionContext,
    OperationResult,
    RequestMessage,
    Signal,
    Utils,
} from "./classes";

/** @hidden */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = debug("orchestrator");

/** @hidden */
export class Entity {
    constructor(public fn: (context: IEntityFunctionContext) => unknown) {}

    public listen(): (context: IEntityFunctionContext) => Promise<void> {
        return this.handle.bind(this);
    }

    private async handle(context: IEntityFunctionContext): Promise<void> {
        const entityBinding = Utils.getInstancesOf<DurableEntityBindingInfo>(
            context.bindings,
            new DurableEntityBindingInfo(new EntityId("samplename", "samplekey"), true, "", [])
        )[0];

        if (entityBinding === undefined) {
            throw new Error("Could not find an entityTrigger binding on context.");
        }

        // Setup
        const returnState: EntityState = new EntityState([], []);
        returnState.entityExists = entityBinding.exists;
        returnState.entityState = entityBinding.state;
        for (let i = 0; i < entityBinding.batch.length; i++) {
            const startTime = new Date();
            context.df = this.getCurrentDurableEntityContext(
                entityBinding,
                returnState,
                i,
                startTime
            );

            try {
                await Promise.resolve(this.fn(context));
                if (!returnState.results[i]) {
                    const elapsedMs = this.computeElapsedMilliseconds(startTime);
                    returnState.results[i] = new OperationResult(false, elapsedMs);
                }
            } catch (error) {
                const elapsedMs = this.computeElapsedMilliseconds(startTime);
                returnState.results[i] = new OperationResult(
                    true,
                    elapsedMs,
                    JSON.stringify(error)
                );
            }
        }

        context.done(null, returnState);
    }

    private getCurrentDurableEntityContext(
        bindingInfo: DurableEntityBindingInfo,
        batchState: EntityState,
        requestIndex: number,
        startTime: Date
    ): DurableEntityContext {
        const currentRequest = bindingInfo.batch[requestIndex];
        return {
            entityName: bindingInfo.self.name,
            entityKey: bindingInfo.self.key,
            entityId: bindingInfo.self,
            operationName: currentRequest.name,
            isNewlyConstructed: !batchState.entityExists,
            getState: this.getState.bind(this, batchState),
            setState: this.setState.bind(this, batchState),
            getInput: this.getInput.bind(this, currentRequest),
            return: this.return.bind(this, batchState, startTime),
            destructOnExit: this.destructOnExit.bind(this, batchState),
            signalEntity: this.signalEntity.bind(this, batchState),
        };
    }

    private destructOnExit(batchState: EntityState): void {
        batchState.entityExists = false;
        batchState.entityState = undefined;
    }

    private getInput(currentRequest: RequestMessage): unknown | undefined {
        if (currentRequest.input) {
            return JSON.parse(currentRequest.input);
        }
        return undefined;
    }

    private getState(returnState: EntityState, initializer?: () => unknown): unknown | undefined {
        if (returnState.entityState) {
            return JSON.parse(returnState.entityState);
        } else if (initializer != null) {
            return initializer();
        }
        return undefined;
    }

    private return(returnState: EntityState, startTime: Date, result: unknown): void {
        returnState.entityExists = true;
        returnState.results.push(
            new OperationResult(
                false,
                this.computeElapsedMilliseconds(startTime),
                JSON.stringify(result)
            )
        );
    }

    private setState(returnState: EntityState, state: unknown): void {
        returnState.entityExists = true;
        returnState.entityState = JSON.stringify(state);
    }

    private signalEntity(
        returnState: EntityState,
        entity: EntityId,
        operationName: string,
        operationInput?: unknown
    ): void {
        returnState.signals.push(
            new Signal(entity, operationName, operationInput ? JSON.stringify(operationInput) : "")
        );
    }

    private computeElapsedMilliseconds(startTime: Date): number {
        const endTime = new Date();
        return endTime.getTime() - startTime.getTime();
    }
}
