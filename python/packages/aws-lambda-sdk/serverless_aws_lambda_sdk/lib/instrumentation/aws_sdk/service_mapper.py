from abc import ABC, abstractmethod


class ServiceMapper(ABC):
    @abstractmethod
    def params(self, trace_span, input):
        pass

    @abstractmethod
    def response_data(self, trace_span, response):
        pass


def _convert_expression_to_string(expression):
    if isinstance(expression, str):
        return expression
    if hasattr(expression, "get_expression"):
        expression_dict = expression.get_expression()
        if isinstance(expression_dict, dict):
            return str(
                {
                    "format": expression_dict.get("format"),
                    "operator": expression_dict.get("operator"),
                    "values": [
                        _convert_expression_to_string(v)
                        for v in expression_dict.get("values", [])
                    ],
                }
            )
    if hasattr(expression, "name"):
        return expression.name

    # fallback to the default string representation
    return str(expression)


class DynamoDBMapper(ServiceMapper):
    def params(self, trace_span, input):
        tags = {}
        if "TableName" in input:
            tags["table_name"] = input["TableName"]
        elif "GlobalTableName" in input:
            tags["table_name"] = input["GlobalTableName"]
        if "ConsistentRead" in input:
            tags["consistent_read"] = input["ConsistentRead"]
        if "Limit" in input:
            tags["limit"] = input["Limit"]
        tags["attributes_to_get"] = input.get("AttributesToGet", [])
        if "ProjectionExpression" in input:
            tags["projection"] = _convert_expression_to_string(
                input["ProjectionExpression"]
            )
        if "IndexName" in input:
            tags["index_name"] = input["IndexName"]
        if "ScanIndexForward" in input:
            tags["scan_forward"] = input["ScanIndexForward"]
        if "Select" in input:
            tags["select"] = input["Select"]
        if "KeyConditionExpression" in input:
            tags["key_condition"] = _convert_expression_to_string(
                input["KeyConditionExpression"]
            )
        if "FilterExpression" in input:
            tags["filter"] = _convert_expression_to_string(input["FilterExpression"])
        if "Segment" in input:
            tags["segment"] = input["Segment"]
        if "TotalSegments" in input:
            tags["total_segments"] = input["TotalSegments"]
        if "ExclusiveStartKey" in input:
            tags["exclusive_start_key"] = input["ExclusiveStartKey"]
        trace_span.tags.update(tags, "aws.sdk.dynamodb")

    def response_data(self, trace_span, response):
        tags = {}
        if "Count" in response:
            tags["count"] = response["Count"]
        if "ScannedCount" in response:
            tags["scanned_count"] = response["ScannedCount"]
        trace_span.tags.update(tags, "aws.sdk.dynamodb")


class SQSMapper(ServiceMapper):
    def params(self, trace_span, input):
        tags = {
            "message_ids": [],
        }
        if "QueueUrl" in input:
            tags["queue_name"] = input.get("QueueUrl").split("/")[-1]
        elif "QueueName" in input:
            tags["queue_name"] = input.get("QueueName")
        trace_span.tags.update(tags, "aws.sdk.sqs")

    def response_data(self, trace_span, response):
        del trace_span.tags["aws.sdk.sqs.message_ids"]
        tags = {}
        if "QueueUrl" in response:
            tags["queue_name"] = response.get("QueueUrl").split("/")[-1]
        if "MessageId" in response:
            tags["message_ids"] = [response.get("MessageId")]
        elif "Successful" in response or "Messages" in response:
            tags["message_ids"] = [
                message.get("MessageId")
                for message in response.get("Successful", response.get("Messages", []))
                if message.get("MessageId")
            ]
        else:
            tags["message_ids"] = []
        trace_span.tags.update(tags, "aws.sdk.sqs")


class SNSMapper(ServiceMapper):
    def params(self, trace_span, input):
        tags = {
            "message_ids": [],
        }
        if "TopicArn" in input:
            tags["topic_name"] = input.get("TopicArn").split(":")[-1]
        trace_span.tags.update(tags, "aws.sdk.sns")

    def response_data(self, trace_span, response):
        del trace_span.tags["aws.sdk.sns.message_ids"]
        tags = {}
        if "TopicArn" in response:
            tags["topic_name"] = response.get("TopicArn").split(":")[-1]
        if "MessageId" in response:
            tags["message_ids"] = [response.get("MessageId")]
        elif "Successful" in response:
            tags["message_ids"] = [
                message.get("MessageId") for message in response.get("Successful", [])
            ]
        trace_span.tags.update(tags, "aws.sdk.sns")


_SERVICE_MAPPERS = {
    "dynamodb": DynamoDBMapper(),
    "sqs": SQSMapper(),
    "sns": SNSMapper(),
}


def get_mapper_for_service(service_name):
    return _SERVICE_MAPPERS.get(service_name)
