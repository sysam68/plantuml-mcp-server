#!/usr/bin/env node
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
declare const LOG_LEVELS: readonly ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];
type LogLevel = (typeof LOG_LEVELS)[number];
declare const BUSINESS_SCENARIO_ELEMENT_TYPES: readonly ["driver", "assessment", "goal", "outcome", "principle", "requirement", "constraint", "value", "meaning", "stakeholder", "businessActor", "businessCollaboration", "businessEvent", "businessInteraction", "businessInterface", "businessObject", "businessProcess", "businessRole", "businessService", "contract", "product", "representation", "applicationCollaboration", "applicationComponent", "applicationEvent", "applicationFunction", "applicationInteraction", "applicationInterface", "applicationProcess", "applicationService", "dataObject", "artifact", "communicationNetwork", "device", "node", "path", "systemSoftware", "technologyCollaboration", "technologyEvent", "technologyFunction", "technologyInteraction", "technologyInterface", "technologyProcess", "technologyService", "distributionNetwork", "equipment", "facility", "material", "assume", "document", "question", "schedule", "change", "reuse", "error"];
type BusinessScenarioElementType = (typeof BUSINESS_SCENARIO_ELEMENT_TYPES)[number];
type BusinessScenarioElement = {
    type: BusinessScenarioElementType;
    label: string;
    code?: string;
    alias: string;
    description?: string;
};
type BusinessScenarioCallInstruction = {
    kind: 'call';
    from: string;
    to: string;
    message?: string;
    arrow?: string;
    from_activation?: 'activate' | 'deactivate';
    to_activation?: 'activate' | 'deactivate';
};
type BusinessScenarioReturnInstruction = {
    kind: 'return';
    message?: string;
};
type BusinessScenarioNoteInstruction = {
    kind: 'note';
    target: string;
    position?: 'left' | 'right' | 'over';
    color?: string;
    text: string;
};
type BusinessScenarioRawInstruction = {
    kind: 'raw';
    text: string;
};
type BusinessScenarioInstruction = BusinessScenarioCallInstruction | BusinessScenarioReturnInstruction | BusinessScenarioNoteInstruction | BusinessScenarioRawInstruction;
type BusinessScenarioDefinition = {
    title?: string;
    elements: BusinessScenarioElement[];
    sequences: BusinessScenarioInstruction[];
};
export declare class PlantUMLMCPServer {
    private server;
    private defaultAuthorization?;
    private clientLogLevel?;
    private supportsCompletions;
    constructor();
    private requireString;
    private optionalString;
    private normalizeArchimateTheme;
    private escapePlantUMLString;
    private indentLine;
    private registerArchimateIdentifiers;
    private buildArchimateElementLines;
    private buildArchimateGroupLines;
    private buildArchimateRelationshipLines;
    private resolveArchimateIdentifier;
    private buildArchimateDocument;
    private getClientLogLevelIndex;
    private shouldForwardLog;
    private formatErrorForClient;
    private forwardLog;
    log(level: LogLevel, message: string, error?: unknown, data?: unknown): void;
    setDefaultAuthorization(authHeader?: string): void;
    private assertAuthorizedForRead;
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    onClose(handler: () => void): void;
    onError(handler: (error: Error) => void): void;
    private setupToolHandlers;
    private setupPromptHandlers;
    private setupResourceHandlers;
    private setupCompletionHandlers;
    private setupLoggingHandlers;
    private normalizeCapabilityGroupings;
    private validatePlantUMLSyntax;
    private generateDiagram;
    private generateArchimateDiagram;
    buildBusinessScenarioFromPayload(args: Record<string, unknown>): {
        format: 'svg' | 'png';
        plantumlCode: string;
        definition: BusinessScenarioDefinition;
    };
    private generateBusinessScenario;
    private generateCapabilityLandscape;
    private normalizeBusinessScenarioElements;
    private normalizeBusinessScenarioInstructions;
    private normalizeNotePosition;
    private registerBusinessScenarioAlias;
    private resolveBusinessScenarioReference;
    private reserveBusinessScenarioAlias;
    private formatSequenceMessage;
    private buildBusinessScenarioDocument;
    private encodePlantuml;
    private decodePlantuml;
}
export {};
//# sourceMappingURL=plantuml-mcp-server.d.ts.map