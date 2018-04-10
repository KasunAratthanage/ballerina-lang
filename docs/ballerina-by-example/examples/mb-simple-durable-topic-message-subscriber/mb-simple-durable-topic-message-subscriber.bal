import ballerina/mb;
import ballerina/log;

endpoint mb:SimpleDurableTopicSubscriber subscriber {
    topicPattern: "myTopic",
    identifier: "sub-1"
};

service<mb:Consumer> jmsListener bind subscriber {

    onMessage(endpoint consumer, mb:Message message) {
        string messageText = check message.getTextMessageContent();
        log:printInfo("Message : " + messageText);
    }
}