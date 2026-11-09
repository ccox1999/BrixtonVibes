import test from 'node:test';
import assert from 'node:assert/strict';
import {KNNClassifier,LogisticRegression} from '../classifier.js';

test('classifier metadata cannot overwrite validated labels or features',()=>{
  for(const Classifier of [KNNClassifier,LogisticRegression]) {
    const model=new Classifier();
    model.addTrainingExample({world_yaw_mean:1},'left',{label:'right',features:{world_yaw_mean:99},recordingId:'kept'});
    assert.equal(model.examples[0].label,'left');
    assert.deepEqual(model.examples[0].features,{world_yaw_mean:1});
    assert.equal(model.examples[0].recordingId,'kept');
    for(const bad of [null,[],1,'features']) assert.throws(()=>model.addTrainingExample(bad,'left'),/Features must be/);
  }
});

test('legacy logistic fitting tolerates nonfinite imported feature values without poisoning every probability',()=>{
  const model=new LogisticRegression();
  for(let i=0;i<8;i++) model.addTrainingExample({world_yaw_mean:i-4},i<4?'right':'left');
  model.addTrainingExample({world_yaw_mean:NaN},'left');
  model.addTrainingExample({world_yaw_mean:Infinity},'right');
  model.addTrainingExample({world_yaw_mean:'invalid'},'right');
  const prediction=model.predictProbability({world_yaw_mean:3});
  assert.ok(Number.isFinite(prediction.pLeft));
  assert.ok(prediction.pLeft>0 && prediction.pLeft<1);
  assert.ok(Number.isFinite(model.mean.world_yaw_mean));
  assert.ok(Number.isFinite(model.std.world_yaw_mean));
});
